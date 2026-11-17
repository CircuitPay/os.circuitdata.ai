import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AUTH_ERROR_CODES, getAuthErrorCode, type FileNameConflict, type TenantFilesApi } from "@gadgets/workshop-shared/api";
import type { RpcStub } from "capnweb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  connect, failure, fresh, installClerkIssuer, mint, signIn, useClerkInDurableObjects,
} from "./clerkFixture";
import { makeUserKey } from "../src/tenant";

let undoClerk: () => void;
const bindings = env as unknown as Record<string, unknown>;

beforeAll(async () => {
  await installClerkIssuer();
  undoClerk = useClerkInDurableObjects();
}, 120_000);

// The limits are read by the capability (from the request's env) and by the directory (from the
// Durable Object's), which both see this object, so a test sets them once.
afterEach(() => {
  delete bindings.TENANT_FILES_MAX_FILE_BYTES;
  delete bindings.TENANT_FILES_QUOTA_BYTES;
});

afterAll(() => {
  undoClerk();
  vi.restoreAllMocks();
});

const bytes = (text: string) => new TextEncoder().encode(text);

function streamOf(data: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) return controller.close();
      controller.enqueue(data.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function upload(files: RpcStub<TenantFilesApi>, name: string, data: Uint8Array,
    options: { onConflict?: FileNameConflict; contentType?: string; declaredSize?: number } = {}) {
  return await files.uploadFile({
    name, size: options.declaredSize ?? data.length,
    contentType: options.contentType ?? "text/plain", onConflict: options.onConflict ?? "reject",
  }, streamOf(data));
}

const names = async (files: RpcStub<TenantFilesApi>) =>
    (await files.listFiles({})).files.map(file => file.name);

async function filesOf(sub: string, org?: string, role?: string) {
  const publicApi = await connect();
  const api = await signIn(publicApi, { sub, org, role });
  return { publicApi, api, files: (await api.getFilesApi())! };
}

const directory = (tenantId: string) => exports.UserDirectoryDurableObject.getByName(tenantId);
const objectsOf = async (tenantId: string) =>
    (await (env as unknown as { TENANT_FILES: R2Bucket }).TENANT_FILES.list({ prefix: `${tenantId}/` })).objects;

describe("uploading and listing", () => {
  it("shows an uploaded file to every member of the organization, with who added it", async () => {
    const org = fresh("org");
    const ann = await filesOf(fresh("ann"), org, "admin");
    const tom = await filesOf(fresh("tom"), org, "basic_member");

    const stored = await upload(tom.files, "plan.txt", bytes("hello"));
    expect(stored).toMatchObject({
      name: "plan.txt", size: 5, contentType: "text/plain", previewable: false,
      uploader: { isMe: true }, mayRemove: true,
    });

    const seenByAnn = (await ann.files.listFiles({})).files;
    expect(seenByAnn).toHaveLength(1);
    expect(seenByAnn[0]).toMatchObject({ name: "plan.txt", uploader: { isMe: false }, mayRemove: true });
    expect(await tom.files.getUsage()).toMatchObject({ usedBytes: 5, fileCount: 1 });
  });

  it("pages newest first and filters by name, taking % and _ literally", async () => {
    const { files } = await filesOf(fresh("ann"), fresh("org"));
    for (const name of ["a.txt", "b_1.txt", "c%.txt", "d.txt"]) await upload(files, name, bytes(name));

    const first = await files.listFiles({ limit: 3 });
    expect(first.files.map(file => file.name)).toEqual(["d.txt", "c%.txt", "b_1.txt"]);
    const second = await files.listFiles({ limit: 3, after: first.next });
    expect(second.files.map(file => file.name)).toEqual(["a.txt"]);
    expect(second.next).toBeUndefined();

    expect(await names(files)).toHaveLength(4);
    expect((await files.listFiles({ query: "B_" })).files.map(file => file.name)).toEqual(["b_1.txt"]);
    expect((await files.listFiles({ query: "%" })).files.map(file => file.name)).toEqual(["c%.txt"]);
    expect((await files.listFiles({ query: "_" })).files.map(file => file.name)).toEqual(["b_1.txt"]);
    expect((await failure(files.listFiles({ after: "x1" }))).message).toBe("Invalid page cursor.");
  });

  it("refuses what is over a limit or not accepted, naming why, and stores nothing", async () => {
    bindings.TENANT_FILES_MAX_FILE_BYTES = "100";
    bindings.TENANT_FILES_QUOTA_BYTES = "150";
    const org = fresh("org");
    const { files } = await filesOf(fresh("ann"), org);

    expect((await failure(upload(files, "big.bin", new Uint8Array(101)))).message)
        .toBe("Files can be at most 100 bytes.");
    await upload(files, "one.bin", new Uint8Array(100));
    expect((await failure(upload(files, "two.bin", new Uint8Array(60)))).message)
        .toBe("Not enough storage: 100 of 150 bytes are in use.");
    expect((await failure(upload(files, "page.html", bytes("<h1>x</h1>")))).message)
        .toBe("This type of file is not accepted.");
    expect((await failure(upload(files, "ok.txt", bytes("x"), { contentType: "image/svg+xml" }))).message)
        .toBe("This type of file is not accepted.");
    expect(await failure(upload(files, "a/b.txt", bytes("x")))).toBeInstanceOf(Error);

    expect(await names(files)).toEqual(["one.bin"]);
    expect((await files.getUsage()).usedBytes).toBe(100);
    expect(await objectsOf(org)).toHaveLength(1);
  });

  it("lists nothing and releases the reservation when the body is not the declared length", async () => {
    const org = fresh("org");
    const { files } = await filesOf(fresh("ann"), org);

    await failure(upload(files, "short.txt", bytes("12345"), { declaredSize: 10 }));
    await failure(upload(files, "long.txt", bytes("1234567890"), { declaredSize: 5 }));

    expect(await names(files)).toEqual([]);
    expect(await files.getUsage()).toMatchObject({ usedBytes: 0, fileCount: 0 });
    expect(await objectsOf(org)).toHaveLength(0);
  });

  it("holds room for an upload in progress, and gives it up when it never finishes", async () => {
    bindings.TENANT_FILES_QUOTA_BYTES = "1000";
    const org = fresh("org");
    const sub = fresh("ann");
    const { files } = await filesOf(sub, org);
    const actor = { userKey: makeUserKey(org, sub), isAdmin: true };

    const reserved = await directory(org).beginFileUpload(
        { name: "pending.bin", size: 900, contentType: "application/octet-stream", onConflict: "reject" }, actor);
    expect(await files.getUsage()).toMatchObject({ usedBytes: 900, fileCount: 0 });
    expect(await names(files)).toEqual([]);
    expect((await failure(upload(files, "x.bin", new Uint8Array(200)))).message).toMatch(/Not enough storage/);

    // An hour passes without the bytes arriving.
    await runInDurableObject(directory(org), (_instance, state) => {
      state.storage.sql.exec(`UPDATE files SET created_at = 0 WHERE state = 'pending'`);
    });
    await upload(files, "x.bin", new Uint8Array(200));
    expect(await files.getUsage()).toMatchObject({ usedBytes: 200, fileCount: 1 });

    // ...so when they do arrive, the upload is refused instead of appearing.
    expect((await failure(directory(org).commitFileUpload(reserved.id, 900, actor))).message)
        .toBe("This upload expired. Try again.");
    expect(await names(files)).toEqual(["x.bin"]);
  });
});

describe("a name that is already taken", () => {
  it("is refused unless the caller chooses to replace or keep both", async () => {
    const org = fresh("org");
    const { files } = await filesOf(fresh("ann"), org);
    await upload(files, "a.txt", bytes("one"));

    expect(await files.findExisting(["a.txt", "b.txt"])).toEqual(["a.txt"]);
    expect((await failure(upload(files, "a.txt", bytes("two")))).message)
        .toBe("A file with this name already exists.");

    const kept = await upload(files, "a.txt", bytes("three"), { onConflict: "keep-both" });
    expect(kept.name).toBe("a (2).txt");
    expect((await upload(files, "a.txt", bytes("four"), { onConflict: "keep-both" })).name).toBe("a (3).txt");

    const replaced = await upload(files, "a.txt", bytes("five!"), { onConflict: "replace" });
    expect(replaced.name).toBe("a.txt");
    expect((await files.listFiles({})).files.filter(file => file.name === "a.txt")).toHaveLength(1);
    expect(await new Response((await files.downloadFile(replaced.id)).stream).text()).toBe("five!");
    // The replaced file's bytes are gone, not just hidden.
    expect(await objectsOf(org)).toHaveLength(3);
  });

  it("can be replaced only by someone who could remove the file", async () => {
    const org = fresh("org");
    const tom = await filesOf(fresh("tom"), org, "basic_member");
    const sue = await filesOf(fresh("sue"), org, "basic_member");
    const ann = await filesOf(fresh("ann"), org, "admin");
    await upload(tom.files, "shared.txt", bytes("tom's"));

    expect((await failure(upload(sue.files, "shared.txt", bytes("sue's"), { onConflict: "replace" }))).message)
        .toBe("You can only replace files you uploaded.");
    expect(await new Response((await tom.files.downloadFile(
        (await tom.files.listFiles({})).files[0].id)).stream).text()).toBe("tom's");

    await upload(ann.files, "shared.txt", bytes("ann's"), { onConflict: "replace" });
    expect(await names(tom.files)).toEqual(["shared.txt"]);
  });

  it("never leaves two live files with one name when uploads race", async () => {
    const { files } = await filesOf(fresh("ann"), fresh("org"));
    const outcomes = await Promise.allSettled(
        ["one", "two", "three"].map(text => upload(files, "race.txt", bytes(text))));

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(await names(files)).toEqual(["race.txt"]);
    expect((await files.getUsage()).usedBytes).toBe(
        (await files.listFiles({})).files[0].size);
  });
});

describe("removing", () => {
  it("is allowed to the uploader and to administrators, and refused to other members", async () => {
    const org = fresh("org");
    const tom = await filesOf(fresh("tom"), org, "basic_member");
    const sue = await filesOf(fresh("sue"), org, "basic_member");
    const ann = await filesOf(fresh("ann"), org, "admin");
    const toms = await upload(tom.files, "toms.txt", bytes("tom"));
    const sues = await upload(sue.files, "sues.txt", bytes("sue"));

    const seenBySue = (await sue.files.listFiles({})).files;
    expect(seenBySue.find(file => file.id === toms.id)?.mayRemove).toBe(false);

    expect((await failure(sue.files.removeFile(toms.id))).message)
        .toBe("You can only remove files you uploaded.");
    expect(await names(tom.files)).toContain("toms.txt");

    await tom.files.removeFile(toms.id);
    await ann.files.removeFile(sues.id);
    expect(await names(ann.files)).toEqual([]);
    expect(await ann.files.getUsage()).toMatchObject({ usedBytes: 0, fileCount: 0 });
    expect(await objectsOf(org)).toHaveLength(0);

    expect((await failure(tom.files.downloadFile(toms.id))).message).toBe("File not found.");
    expect((await failure(tom.files.removeFile(toms.id))).message).toBe("File not found.");
  });

  it("follows a role change delivered at renewal, without a reconnect", async () => {
    const org = fresh("org");
    const sub = fresh("ann");
    const tom = await filesOf(fresh("tom"), org, "basic_member");
    const ann = await filesOf(sub, org, "admin");
    const toms = await upload(tom.files, "toms.txt", bytes("tom"));
    expect((await ann.files.listFiles({})).files[0].mayRemove).toBe(true);

    await ann.api.renewSession(await mint({ sub, org, role: "basic_member" }));

    expect((await ann.files.listFiles({})).files[0].mayRemove).toBe(false);
    expect((await failure(ann.files.removeFile(toms.id))).message)
        .toBe("You can only remove files you uploaded.");
    expect(await names(tom.files)).toEqual(["toms.txt"]);
  });

  it("hides a removal whose delete failed, keeps it counted, and finishes it later", async () => {
    const org = fresh("org");
    const { files } = await filesOf(fresh("ann"), org);
    const stored = await upload(files, "gone.txt", bytes("12345"));
    // The state a removal is left in when the bucket delete throws.
    await runInDurableObject(directory(org), (_instance, state) => {
      state.storage.sql.exec(`UPDATE files SET state = 'removing' WHERE id = ?`, stored.id);
    });

    expect(await names(files)).toEqual([]);
    expect((await failure(files.downloadFile(stored.id))).message).toBe("File not found.");
    // The next listing sweeps it away.
    expect(await objectsOf(org)).toHaveLength(0);
    expect(await files.getUsage()).toMatchObject({ usedBytes: 0, fileCount: 0 });
  });
});

describe("downloading", () => {
  it("returns the same bytes, however large, and opens only images and PDFs inline", async () => {
    const { files } = await filesOf(fresh("ann"), fresh("org"));
    const big = new Uint8Array(3 * 1024 * 1024 + 17).map((_, index) => (index * 31) % 251);
    const stored = await upload(files, "big.bin", big, { contentType: "application/octet-stream" });
    const image = await upload(files, "pic.png", bytes("not really"), { contentType: "image/png" });
    const text = await upload(files, "notes.txt", bytes("hi"), { contentType: "text/plain" });

    const download = await files.downloadFile(stored.id);
    expect(download).toMatchObject({ name: "big.bin", size: big.length });
    const received = new Uint8Array(await new Response(download.stream).arrayBuffer());
    expect(received.length).toBe(big.length);
    expect(received.every((value, index) => value === big[index])).toBe(true);

    expect(image.previewable).toBe(true);
    expect((await files.downloadFile(image.id)).contentType).toBe("image/png");
    expect(text.previewable).toBe(false);
    expect((await files.downloadFile(text.id)).contentType).toBe("application/octet-stream");
  });
});

describe("isolation between workspaces", () => {
  it("keeps two organizations' files apart, even under the same name and a guessed id", async () => {
    const orgA = fresh("org");
    const orgB = fresh("org");
    const a = await filesOf(fresh("ann"), orgA);
    const b = await filesOf(fresh("bob"), orgB);
    const inA = await upload(a.files, "report.txt", bytes("A's secret"));
    const inB = await upload(b.files, "report.txt", bytes("B's"));

    expect((await a.files.listFiles({})).files.map(file => file.id)).toEqual([inA.id]);
    expect((await b.files.listFiles({})).files.map(file => file.id)).toEqual([inB.id]);
    expect(await new Response((await a.files.downloadFile(inA.id)).stream).text()).toBe("A's secret");

    // Another tenant's id is answered exactly like one that never existed.
    const random = crypto.randomUUID();
    const refusedDownload = await failure(b.files.downloadFile(inA.id));
    expect(refusedDownload.message).toBe((await failure(b.files.downloadFile(random))).message);
    const refusedRemoval = await failure(b.files.removeFile(inA.id));
    expect(refusedRemoval.message).toBe((await failure(b.files.removeFile(random))).message);
    expect(await names(a.files)).toEqual(["report.txt"]);
    expect(await b.files.findExisting(["report.txt"])).toEqual(["report.txt"]);
    expect((await a.files.getUsage()).usedBytes).toBe("A's secret".length);
  });

  it("gives a personal workspace its own area, in which the owner may remove anything", async () => {
    const sub = fresh("solo");
    const org = fresh("org");
    const personal = await filesOf(sub);
    const inOrg = await filesOf(sub, org, "basic_member");
    await upload(inOrg.files, "work.txt", bytes("org"));
    const mine = await upload(personal.files, "mine.txt", bytes("mine"));

    expect(await names(personal.files)).toEqual(["mine.txt"]);
    expect(await names(inOrg.files)).toEqual(["work.txt"]);
    expect(mine.mayRemove).toBe(true);
    await personal.files.removeFile(mine.id);
    expect(await names(personal.files)).toEqual([]);
  });

  it("refuses a capability once the session stops renewing as the same user and tenant", async () => {
    const org = fresh("org");
    const sub = fresh("tom");
    const tom = await filesOf(sub, org, "basic_member");
    await upload(tom.files, "a.txt", bytes("a"));

    // Renewal in another tenant is refused and the connection is closed shortly after.
    await failure(tom.api.renewSession(await mint({ sub, org: fresh("other"), role: "admin" })));
    const refused = await failure(tom.files.listFiles({}));
    expect(getAuthErrorCode(refused)).toBe(AUTH_ERROR_CODES.sessionExpired);
  });

  it("is not offered when the deployment has no file storage", async () => {
    const publicApi = await connect({ TENANT_FILES: undefined });
    using api = await signIn(publicApi, { sub: fresh("ann"), org: fresh("org") });
    expect(await api.getFilesApi()).toBeNull();
  });

  it("deletes an erased organization's files and no one else's", async () => {
    const orgA = fresh("org");
    const orgB = fresh("org");
    const a = await filesOf(fresh("ann"), orgA);
    const b = await filesOf(fresh("bob"), orgB);
    await upload(a.files, "a.txt", bytes("a"));
    await upload(a.files, "b.txt", bytes("b"));
    await upload(b.files, "c.txt", bytes("c"));

    await directory(orgA).eraseTenant(Date.now());

    expect(await objectsOf(orgA)).toHaveLength(0);
    expect(await objectsOf(orgB)).toHaveLength(1);
    expect(await names(b.files)).toEqual(["c.txt"]);
  });
});

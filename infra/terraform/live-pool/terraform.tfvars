account_id    = "00b0a47be12ddf1494f1d05264a219e4"
instance_name = "pool"
release_dir   = "../../../release-out"

hostname  = "os.circuitdata.ai"
zone_name = "circuitdata.ai"

clerk_issuer          = "https://kind-dragon-9982.clerk.accounts.dev"
clerk_publishable_key = "pk_test_a2luZC1kcmFnb24tOTk4Mi5jbGVyay5hY2NvdW50cy5kZXYk"

# Clerk user ids of the deployment operators (who can open /admin).
operators = ["user_3KxnKc7gPJNPyeEesyCUWXwooIG"]

# Optional integrations beyond the context library and the scheduler:
# gatekeepers = { github = {} }

# Secrets do not belong in this file. Supply them from the environment instead:
#   export TF_VAR_clerk_webhook_secret='whsec_...'
#   export TF_VAR_gatekeeper_secrets='{"github":{"CLIENT_ID":"...","CLIENT_SECRET":"..."}}'

# One AI Gateway for every organization. Requests are tagged with their client (the organization id),
# so usage is split per organization from the gateway logs. default_client tags pre-Clerk accounts.
ai_gateway = { enabled = true, name = "gadgets-pool", create = true, default_client = "unassigned" }

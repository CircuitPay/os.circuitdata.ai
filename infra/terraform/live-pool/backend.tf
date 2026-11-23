# State holds secrets (webhook secret, integration credentials). Use an encrypted remote backend with
# state locking, one state per instance. For example, Cloudflare R2 through its S3 API:
#
terraform {
  backend "s3" {
    bucket                      = "terraform-state"
    key                         = "gadgets/pool/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://00b0a47be12ddf1494f1d05264a219e4.r2.cloudflarestorage.com/terraform-state" }
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_lockfile                = true
  }
}

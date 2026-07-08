variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with Account:Cloudflare Tunnel:Edit and Zone:DNS:Edit permissions."
  sensitive   = true
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID that owns the tunnel."
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID for the hostname's domain."
}

variable "domain" {
  type        = string
  description = "Apex or parent domain under which the tunnel hostname is created (e.g. example.com)."
}

variable "tunnel_name" {
  type        = string
  description = "Name for the Cloudflare Tunnel resource and the DNS hostname prefix."
  default     = "pelaggio"
}

variable "tunnel_target" {
  type        = string
  description = "Local HTTP origin that cloudflared proxies to on the daemon box."
  default     = "http://127.0.0.1:7777"
}

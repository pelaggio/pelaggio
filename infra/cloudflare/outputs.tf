output "tunnel_id" {
  value       = cloudflare_zero_trust_tunnel_cloudflared.autopilot.id
  description = "ID of the created Cloudflare Tunnel."
}

output "tunnel_token" {
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.autopilot.token
  description = "Token the cloudflared daemon uses to dial Cloudflare. Paste into ~/.config/cloudflared.env as TUNNEL_TOKEN. Regenerated if the tunnel resource is replaced — reapply, update env, then restart cloudflared to rotate."
  sensitive   = true
}

output "hostname" {
  value       = "${var.tunnel_name}.${var.domain}"
  description = "Public hostname that fronts the daemon."
}

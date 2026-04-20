resource "cloudflare_dns_record" "autopilot" {
  zone_id = var.zone_id
  name    = "${var.tunnel_name}.${var.domain}"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.autopilot.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

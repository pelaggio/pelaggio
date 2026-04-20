resource "cloudflare_zero_trust_tunnel_cloudflared" "autopilot" {
  account_id    = var.cloudflare_account_id
  name          = var.tunnel_name
  config_src    = "cloudflare"
  tunnel_secret = base64encode(random_password.tunnel_secret.result)
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "autopilot" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.autopilot.id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "autopilot" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.autopilot.id

  config = {
    ingress = [
      {
        hostname = "${var.tunnel_name}.${var.domain}"
        service  = var.tunnel_target
      },
      {
        service = "http_status:404"
      }
    ]
  }
}

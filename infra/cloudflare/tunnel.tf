resource "cloudflare_zero_trust_tunnel_cloudflared" "pelaggio" {
  account_id    = var.cloudflare_account_id
  name          = var.tunnel_name
  config_src    = "cloudflare"
  tunnel_secret = base64encode(random_password.tunnel_secret.result)
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "pelaggio" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.pelaggio.id
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "pelaggio" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.pelaggio.id

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

# Security policy

Voltra is intended for trusted LAN or VPN deployment. Never expose its HTTP port directly to the public Internet. Use HTTPS via an authenticated reverse proxy when accessed outside the LAN.

- Set a strong VOLTRA_PASSWORD before binding to 0.0.0.0.
- Restrict each upstream MatterBridge HTTP port (normally 8086) with firewall rules; the source project has no built-in authentication.
- Matter pairing QR/manual codes must be treated as sensitive.
- The Add Bridge form accepts local network targets by default; only enable VOLTRA_ALLOW_PUBLIC_UPSTREAMS if absolutely necessary and you control the target.
- Do not use the source project's test/debug endpoints for exposed deployments.

If you identify a security issue, avoid posting exploit details in a public issue. Prefer a private GitHub security advisory to the repository owner.

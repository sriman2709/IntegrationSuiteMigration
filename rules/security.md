# Security — AKS React & Node.js Microservices

## 🔐 Security & RBAC (BTP XSUAA + AKS)
- **JWT Validation:** Every Node.js microservice must use `@sap/xssec` to verify tokens.
- **Scope Check:** Enforce RBAC at the Controller level: `req.authInfo.checkLocalScope('Admin')`.
- **Secrets:** Use **Azure Key Vault** references in Kubernetes manifests — never hardcode env vars or plain Helm values.
- **Network Policies:** Every microservice must have a Kubernetes `NetworkPolicy` that restricts ingress to known services only.
- **Image Scanning:** Container images must be scanned with Trivy before pushing to ACR.

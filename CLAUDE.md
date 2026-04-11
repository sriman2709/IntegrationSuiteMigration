<!--
  CLAUDE.md — AI Instruction File for AKS React & Node.js Microservices Project
  ==============================================================================
  This file is automatically loaded by Claude Code at the start of every session
  in this directory. It defines the rules, standards, and constraints that Claude
  must follow when generating, modifying, or reviewing code in this project.

  WHO THIS IS FOR:
    - Claude AI (primary consumer — read and enforced automatically)
    - Developers onboarding to this project (reference for standards)

  HOW IT WORKS:
    - Claude reads this file before every task and applies all rules without
      being asked. You do not need to repeat these instructions in your prompts.
    - The "AI Efficiency & Context Rules" section at the top is the most critical
      — always specify the target layer (Controller / Service / Model) in prompts
      to prevent Claude from generating code that bleeds across boundaries.

  SCOPE: Azure Kubernetes Service (AKS) — React frontend + Node.js microservices
         with gRPC internal communication and Azure Service Bus for async events.
  STACK: React 18 | Node.js 20 LTS | TypeScript 5 | Prisma 5 | Helm 3 | gRPC
  LAST UPDATED: 2026-03-26
-->

# AKS Enterprise Project: React & Node.js Microservices (MVC)

## 🤖 AI Efficiency & Context Rules (CRITICAL)
- **Context Pinning:** When asking AI to create a feature, specify the **Layer** (e.g., "Create a Service layer method for...") to prevent code bloating the Controller.
- **DRY/SOLID Enforcement:** AI must prioritize **Dependency Injection**. Services should be injected into Controllers to facilitate easy mocking.
- **Type Safety:** Always use **TypeScript**. AI must generate Interfaces for all API responses to ensure the React frontend remains type-synced with Node.js.
- **Error Handling:** AI must use a global error-handling middleware pattern. Do not allow `try-catch` blocks to be duplicated in every controller.
- **Secrets via Key Vault:** Always reference Azure Key Vault or Helm values for secrets — never hardcode image tags or cluster-specific config.

## 📌 Dependency Versions (AI must target these)
- Node.js: 20 LTS
- TypeScript: ^5.x
- React: ^18.x
- `@sap/xssec`: ^3.x
- `@sap-cloud-sdk/http-client`: ^3.x
- Jest: ^29.x / Vitest: ^1.x
- Prisma: ^5.x
- `opossum`: ^8.x (circuit breaker)
- Helm: ^3.x
- Kubernetes API: 1.28+

## 🛠 Deployment & Workflow (AKS)
- **Containerization:** Multistage `Dockerfile` (Node 20 Alpine builder → Node 20 Alpine runtime).
- **Orchestration:** Helm charts for all Kubernetes manifests.
- **Ingress:** NGINX Ingress for routing and SSL termination.
- **Commands:**
  - `docker build -t <service-name>:<git-sha> .`
  - `helm upgrade --install <release> ./charts --set image.tag=<git-sha>`
  - `kubectl logs -f <pod-name>`
  - `buf lint` (validate proto files)
  - `npx prisma migrate deploy` (apply migrations)

## 📊 Observability
- **Logging:** Use `winston` with JSON formatter.
- **Log Fields:** Include `service`, `timestamp`, and `traceId` in every entry (plus the global `correlationId` and `userId`).
- **Tracing:** Use OpenTelemetry SDK. Propagate `traceparent` header across all gRPC and HTTP calls.
- **Metrics:** Expose Prometheus metrics at `/metrics` using `prom-client`.
- **Alerts:** Every service must have an Azure Monitor alert for error rate > 1% and p99 latency > 2s.

@rules/coding-style.md
@rules/testing.md
@rules/security.md

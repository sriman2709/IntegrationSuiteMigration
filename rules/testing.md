# Testing — AKS React & Node.js Microservices

## 🧪 Testing & Quality
- **Unit Tests:** Frontend: Vitest/React Testing Library. Backend: Jest for Service/Model layers.
- **Contract Testing:** Use **Pact** for Microservice-to-Microservice API stability.
- **Performance:** Every Node.js service must include a `/health` (liveness) and `/ready` (readiness) endpoint for AKS probes.
- **gRPC:** Use `grpc-mock` to test gRPC client calls in unit tests.

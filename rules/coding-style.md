# Coding Style — AKS React & Node.js Microservices

## 📐 Naming Conventions
- **Files:** kebab-case (`order-service.ts`, `purchase-order-controller.ts`, `order-card.module.css`)
- **Classes:** PascalCase (`OrderService`, `PurchaseOrderController`)
- **Interfaces:** PascalCase with `I` prefix (`IOrderResponse`, `IUserClaims`)
- **REST Routes:** kebab-case, versioned (`/api/v1/purchase-orders`)
- **Kubernetes resources:** kebab-case (`order-service-deployment`, `api-gateway-ingress`)
- **Helm values:** camelCase (`replicaCount`, `imageTag`, `keyVaultSecretName`)
- **Proto messages:** PascalCase (`GetOrderRequest`, `OrderResponse`)
- **gRPC service methods:** PascalCase (`GetOrder`, `CreatePurchaseRequisition`)

## 🏗 Microservice & MVC Architecture
- **Separation of Concerns:**
  - **View:** React.js (Client) — Logic-less components, state managed by hooks.
  - **Controller:** Node.js API routes — Orchestrates data flow and validates input.
  - **Model:** Node.js Services/Data Access Layer — Handles HANA/Postgres logic and External APIs.
- **Service Boundaries:** Each Microservice must have its own database schema (Loose Coupling).
- **Communication:** Use **gRPC** for synchronous internal calls and **Azure Service Bus** for async events.

## 📐 TypeScript Rules
- `strict: true` in all `tsconfig.json` files — no exceptions.
- All API response shapes must have a shared Interface in `shared/types/`.
- Never use `any` — use `unknown` with type guards, or proper generics.
- Use **Zod** for runtime validation of all external API responses (S/4HANA, 3rd party).
- AI must generate types for all new API contracts before writing implementation code.

## 📡 gRPC / Service Contracts
- `.proto` files are the source of truth — never deviate from them in implementation.
- Use **Buf** for linting proto files: `buf lint`.
- Breaking proto changes (removing fields, changing types) require a major version bump.
- AI must never modify a `.proto` file and implementation file in a single step — always confirm the contract change first.

## ⚠️ Error Handling
- Use a **global error-handling middleware** in each Express service (`middleware/error-handler.ts`) — no duplicated `try-catch` in controllers.
- Controllers catch errors and pass them to `next(err)` — never handle errors inline in routes.
- Map known error types (XSUAA 401, gRPC status codes, circuit breaker open) to appropriate HTTP status codes.
- API errors must follow **RFC 7807 Problem Details** format.

## 💻 Service & Logic Standards
- **Clean Architecture:** Business logic stays in "Service" classes — never in Controllers or route handlers.
- **Resilience:** Use `opossum` for Circuit Breakers on all external SAP/S4 calls.
- **Persistence:** Use Prisma. No raw SQL — use Prisma query builder or `$queryRaw` only for documented edge cases.
- **API Design:** Version all routes (`/api/v1/`). Follow REST conventions. Responses follow RFC 7807 on error.

## 🗄 Database Migrations
- Use **Prisma Migrate** for all schema changes — never manual SQL or ad-hoc scripts.
- Migrations must be **backwards-compatible** (additive only) to support zero-downtime rolling deploys on AKS.
- AI must never generate a migration that drops a column or table without an explicit confirmation from the user.
- Migration files are committed to source control and reviewed in PRs like application code.

## 🔄 CI/CD (GitHub Actions / Azure DevOps)
- Every PR must pass: lint, type-check (`tsc --noEmit`), unit tests, contract tests (Pact), and Docker build.
- Image tags must be the **Git commit SHA** — never use `latest` in production Kubernetes manifests.
- Helm values for secrets must reference Azure Key Vault — never plain string values.
- Staging deployment is automatic on merge to `main`; production requires manual approval gate.

## 🎨 React UI & CSS Standards

### CSS Authoring Rules
- **CSS Modules only** — one `.module.css` per component, colocated in the same directory. No styled-components, no Tailwind, no inline styles.
- **No inline styles** — `style={{}}` is forbidden except for truly dynamic computed values (e.g., runtime-calculated widths). Flag any other use.
- **No global stylesheets** for component styles — only `src/styles/global.css` may contain resets and body defaults.
- **No `!important`** — flag any use before adding.
- **No magic numbers** — never write raw hex colors, px font sizes, or arbitrary spacing values. Always reference design tokens.

### Design Tokens
- All tokens live in `src/styles/tokens.css` as CSS custom properties — read this file before adding any new value.
- **Colors:** Use semantic token names — `var(--color-primary)`, `var(--color-error)`, `var(--color-surface)`. Never use hex codes directly in component stylesheets.
- **Typography:** `var(--font-family-base)`, `var(--font-size-sm)`, `var(--font-size-md)`, `var(--font-size-lg)`, `var(--font-weight-bold)`.
- **Spacing:** Use the 4px grid — `var(--spacing-xs)` (4px), `var(--spacing-sm)` (8px), `var(--spacing-md)` (16px), `var(--spacing-lg)` (24px), `var(--spacing-xl)` (32px).
- **Borders:** `var(--border-radius-sm)`, `var(--border-radius-md)`, `var(--border-color-default)`.
- **Elevation:** `var(--shadow-sm)`, `var(--shadow-md)`, `var(--shadow-lg)` — never write raw `box-shadow` values.
- If a token does not exist for a value, propose adding it to `tokens.css` rather than using a raw value inline.

### Naming Within CSS Modules
- Use **kebab-case** class names: `.order-header`, `.status-badge`.
- Follow BEM modifier pattern: `.card`, `.card__title`, `.card__title--active`.
- Names must describe **purpose**, not appearance: `.danger-action` not `.red-button`.

### Responsive Design
- **Mobile-first:** Base styles target small screens; use `@media (min-width: ...)` for larger viewports.
- Breakpoints must come from `src/styles/breakpoints.css` — never hardcode `px` values in media queries.
- Use CSS Grid or Flexbox for layout — never use absolute positioning or float-based layout.
- Container max-widths must use a token, not a hardcoded value.

### Component Structure
- One component = one directory: `OrderCard/OrderCard.tsx` + `OrderCard.module.css` + `OrderCard.test.tsx`.
- Logic-less components: no API calls, no business logic inside components — delegate to hooks.
- Never pass a `className` prop down more than one level to style a child — compose styles at the component boundary.

### Accessibility
- All interactive elements must have `aria-label` or `aria-labelledby`.
- Never remove focus outlines — replace with a visible custom focus style if the default is unacceptable.
- Use semantic HTML (`<button>`, `<nav>`, `<main>`, `<section>`) — never use a `<div>` with an `onClick` where a `<button>` would be correct.

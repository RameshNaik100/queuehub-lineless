# QueueHub — LineLess

**Join. Track. Get notified. Show up when it’s your turn.**

Turn physical waiting into a simple, smart virtual queue.

QueueHub is a polished, responsive prototype for **PS02: Smarter Queues & Shared Services**. It demonstrates the onboarding-first model: an organization creates a private tenant, configures its own services and schedules, publishes service-specific QR/link access, staff operate live queues, and customers join without creating a QueueHub account.

## What is included

- Organization registration and organization-scoped admin login
- Role-aware admin and staff workspaces
- Empty workspaces for new organizations — no organization is discoverable from the landing page
- Service creation with:
  - specific dates or recurring days
  - queue opening, service start, closing, and last-token cutoff times
  - daily capacity, number of counters, rolling average service time
  - configurable missed-customer grace period (120 seconds by default)
  - notification setting and publish/draft state
- Per-service customer links and real scannable QR codes generated locally (no QR API dependency)
- A small shared queue API (`server.js`) so customer joins from different browsers/devices append to one service queue
- One-click WhatsApp sharing plus QR download for posters, signage, websites, email, and other channels
- Public organization service picker and service-specific customer page
- Account-free customer joining flow with:
  - real token generation
  - duplicate active-token protection by phone number
  - queue position, live now-serving token, ETA range
  - priority request that must be verified by staff
- Staff queue controls:
  - Call Next with counter assignment
  - Mark Completed
  - Skip waiting tokens
  - Missed-customer grace countdown and No-show
  - Recall skipped/no-show tokens later
  - Pause / Resume queue
  - Verify priority request
- Actual service-time recording on completion and rolling ETA recalculation
- Admin overview, staff management, settings, service health, and analytics surfaces
- Responsive desktop/tablet/mobile UI
- SQLite is the authoritative source for organizations, queue entries, history, and notifications; browser storage only remembers the local session/customer token view
- Seeded VSSUT Student Services demo tenant, reachable only by its private links / credentials and never listed on the landing page

## Run locally

Install the backend dependencies once, then start the single backend/frontend server:

```bash
cd /home/user
npm install
node server.js
```

For deployment, set a public origin before starting the server:

```bash
PUBLIC_BASE_URL=https://your-domain.com npm start
```

Then open `http://localhost:4173`.

For the hosted Arena preview, the same shared server is served on the live preview port. The server persists public service/queue data in `queueflow.sqlite` and broadcasts queue changes over WebSockets.
For local development, the browser uses the current origin only when it is a shareable deployment origin. If you are running on `localhost`, set `window.QUEUEFLOW_PUBLIC_ORIGIN` to the HTTPS origin that phones/judges can reach before sharing QR codes. The app intentionally does not generate a misleading localhost QR code.

## End-to-end usage

### 1. Create a service

1. Register an organization at `#/register`.
2. You are sent to the private Admin workspace.
3. Open **Services & links** from the left navigation, then select **Create service**.
4. Enter a service name, description, dates or recurring days, queue opening time, closing time, capacity, counters, and average service time.
5. Leave **Publish immediately** selected and choose **Create & publish**.
6. QueueHub saves the service, shows it in the service directory, and opens the **Share** panel automatically. The directory also shows the complete customer link and an **Open customer page** button.

If a service is created as a draft, it still appears in the admin directory. Select **Publish** on that row to make the public customer page available.

### 2. Give staff access

1. From the Admin workspace, open **Staff accounts**.
2. Select **Add staff account**.
3. Enter the staff member’s name, email, and temporary password.
4. QueueHub stays on Staff Management, adds the new row immediately, and shows a success banner with the login URL and credentials.
5. The staff member opens `#/login`, signs in with those credentials, and is sent to `#/staff`.
6. The Staff Queue Control screen lists every published service in that organization. Staff select a service, then use **Call next**, **Complete**, **Skip**, **Recall**, or **Pause**.

Staff accounts are scoped to the organization that created them. They cannot access another organization’s services, admin settings, or analytics.

### 3. Let a customer join

1. From Admin → **Services & links**, copy the visible customer link, click **Open customer page**, or download the service QR.
2. Share the link / QR on a poster, entrance sign, website, WhatsApp message, or email.
3. The customer opens the service page without a QueueHub account.
4. When the queue is open, the customer selects **Join queue**, enters a name and phone number, and receives a real token such as `B001`.
5. The token page shows now serving, people ahead, estimated wait, service status, and live notices.
6. Staff call the token and complete it. The customer’s page can be refreshed to see the changed state and updated ETA for the remaining queue.

Queue opening, capacity, duplicate active-token prevention, last-token cutoff, paused queues, closed queues, and next scheduled date states are all enforced by the customer page.

## Exact website walkthrough

QueueHub is tenant-scoped. A service created inside one organization will not appear under another organization’s public link. For example, a service created in a newly registered organization will not appear on the seeded `#/o/vssut-student-services` page. Always use the customer link generated for the organization where the service was created.

### Admin: create and publish a service

1. Open `#/register` and register an organization, or use an existing admin account at `#/login`.
2. After login, open **Services & links** from the left navigation.
3. Click **Create service**.
4. Enter the service name, description, token prefix, schedule, hours, capacity, counters, and average service time.
5. Keep **Publish immediately** selected.
6. Click **Create & publish**.
7. The service should now appear as a row in **Your services**. The row includes:
   - `Published` status
   - Today’s token count
   - The complete customer URL
   - Copy link button
   - QR/share button
   - **Open customer page** button
8. A green success banner also shows the new service URL. Select **Open** in that banner to open the customer page, or select **Share / QR** to copy/download the link.

If you leave **Publish immediately** unchecked, the service is saved as a draft. It remains visible to the admin but does not appear on the public organization page until you select **Publish**.

### Customer: open the service page and join

The customer page is the route shown in the service link, for example:

```text
#/o/your-organization-slug/s/your-service-slug
```

A customer does not log in. The page shows the organization name, service name, schedule, queue status, service hours, counters, current token, number of people waiting, and average service time. When the queue is open:

1. Customer selects **Join queue**.
2. Customer enters a name and phone number.
3. QueueHub prevents another active token for the same phone number in that service session.
4. QueueHub creates the next token, such as `B001`.
5. The token page displays:
   - Customer token
   - Now serving token
   - People ahead
   - Estimated wait range
   - Active / next / completed status
   - Counter when staff calls the token
   - Live notices such as “Your turn is approaching” and “You are next”

If the queue is before opening time, full, paused, closed, or not scheduled today, the same customer page explains the state and shows the next available date where possible.

### Staff: access and operate the queue

1. Admin opens **Staff accounts**.
2. Admin selects **Add staff account** and enters a name, email, and temporary password.
3. QueueHub saves the account and shows its login page, email, and temporary password.
4. Staff opens `#/login` and signs in with those credentials.
5. Staff is sent to `#/staff`.
6. Staff selects a published service from the service selector.
7. The queue control page shows the current token, next waiting tokens, people ahead, priority requests, and today’s activity.
8. Staff can:
   - **Call next** — changes the next waiting token to `called`
   - **Complete** — records the service duration and recalculates ETA
   - **Skip** — marks a token skipped
   - **Recall** — reminds the current customer to proceed
   - **Pause / Resume** — stops or restarts new customer joins
   - **Verify** — approves a priority request; customers can never self-promote

Open the customer page in another same-origin tab to observe the queue state update as staff calls and completes tokens.

### If a newly created service is not visible

- Refresh the preview once so the cache-busted `app.js?v=20260920` loads.
- Confirm you are signed in as the admin of the organization that owns the service.
- Open **Admin → Services & links**, not the seeded VSSUT public page.
- Check whether the row says `Published` or `Draft`. Draft services need **Publish**.
- Use the customer URL shown on the service row or the **Open customer page** button. Do not manually use another organization’s slug.
- If the browser has an old prototype state, clear site storage once and register the organization again.

## Routes

The app uses hash routing so links work from a static server without a server-side rewrite:

| Route | Purpose |
|---|---|
| `#/` | Organization-agnostic landing page |
| `#/register` | Register a new organization + first admin |
| `#/login` | Admin/staff login |
| `#/admin` | Admin workspace |
| `#/staff` | Staff queue workspace |
| `#/o/:orgSlug` | Private organization service picker |
| `#/o/:orgSlug/s/:serviceSlug` | Private service queue page |

A production deployment can replace hash routing with the corresponding server routes in the prompt (`/admin/:orgId/dashboard`, `/o/:orgSlug/s/:serviceSlug`) while keeping the same UI states and API boundaries.

## Judge demo script

Use the hosted live preview URL for this demonstration, not `localhost`, so a phone can open the link from the QR code. The QR generator uses the current website origin, so the QR points back to the QueueHub service page on the preview website.

### Fastest demo

1. Open the public demo service page: `#/o/ramesh-student-service-center/s/student-certificate`.
2. The seeded queue starts with `SC001` serving and `SC002`–`SC005` waiting, so the page immediately shows **Now serving**, **People ahead**, **Average service time**, and the service schedule.
3. Open the same service URL in three or more tabs/devices and select **Join queue**. Each join is written to SQLite and receives the next shared token.
4. Log in as the seeded staff account in another tab: `staff@demo.com` / `Staff123`.
5. In **Staff Queue Control**, select **Student Certificate** and use **Call next** or **Complete**.
6. All connected customer pages receive the queue update through WebSockets; the customer view updates without a manual refresh.
7. Select **Settings → Presentation demo → Reset demo queue** to return to `SC001` serving and `SC002`–`SC005` waiting.

### Full organization-to-customer demo

1. Register a new organization.
2. Create a service with **Create & publish**.
3. Use the automatically opened Share panel to copy the service link, open WhatsApp sharing, or download the real QR SVG.
4. Show the green success banner and the service row under **Services & links**.
5. Open **Open customer page** to show the customer-facing service page.
6. Create a staff account, then log in at `#/login` as that staff member.
7. Open the customer service page in another tab, select **Join queue**, and enter customer details.
8. Use the staff queue controls to call, complete, skip, recall, or pause the queue.

## Demo tenant

The Ramesh demo tenant is seeded into both SQLite and browser state but is **not shown on the public landing page**.

- Organization public service picker: `#/o/ramesh-student-service-center`
- Student Certificate customer page: `#/o/ramesh-student-service-center/s/student-certificate`
- Admin email: `admin@demo.com`
- Admin password: `Admin123`
- Staff email: `staff@demo.com`
- Staff password: `Staff123`
- Additional staff: `priya@demo.com` / `Staff123`
- Demo services: Student Certificate, Scholarship Application, Examination Support, ID Card Service
- Demo queue reset: Admin → Settings → Presentation demo → Reset demo queue

The initial Student Certificate queue is `SC001` serving, followed by `SC002` through `SC005` waiting. The existing VSSUT demo remains available for backward compatibility:

- Organization picker: `#/o/vssut-student-services`
- Admin: `admin@vssut.queueflow.demo` / `demo1234`
- Staff: `staff@vssut.queueflow.demo` / `demo1234`

## Data model used by the prototype

The browser may remember the signed-in session and customer token between refreshes, but it is not the queue source of truth. Public service metadata, tokens, notifications, and status history are stored by `server.js` in SQLite. This is what lets a customer on another browser or phone join the same service queue instead of creating an isolated local queue. The tenant-first model is:

```text
Organization
  ├── User (admin | staff)
  └── Service
        ├── Schedule (specific dates or recurring days)
        └── Token / service records
```

Every organization owns its users and services. Public routes resolve an organization by its private slug and then a service by its private service slug. Admin/staff actions first resolve the current organization from the signed-in session before reading or mutating records.

The SQLite/WebSocket bridge is a minimal prototype transport, not a production security boundary. Admin credentials remain local-only for demonstration. The shared queue is consistent across devices while the server is running, and connected queue screens receive updates through WebSockets with polling as a reconnect fallback. Production should add tenant-scoped authentication, HTTPS, and a managed PostgreSQL deployment.

## Current backend implementation

- Node.js HTTP server in `server.js`
- SQLite database in `queueflow.sqlite` via `better-sqlite3`
- REST-style JSON endpoints under `/api/shared/services/...`
- Native WebSocket endpoint under `/ws/services/:orgSlug/:serviceSlug` via `ws`
- SQLite tables for organizations, users/staff, customers, services, queue entries, notifications, and queue history
- `PUBLIC_BASE_URL` environment variable injection for deployed QR/link origins
- Optional `API_BASE_URL` environment variable for a separately hosted backend; same-origin relative API URLs are the default

Recommended production implementation:

```text
React + TypeScript + Tailwind
        ↓
Express + TypeScript REST API
        ↓
Prisma ORM + PostgreSQL
        ↓
Socket.IO event layer
```

Suggested core tables:

- `Organization`
- `User`
- `Service`
- `Schedule`
- `ServiceSession`
- `Counter`
- `StaffAssignment`
- `QueueEntry` / `Token`
- `ServiceRecord`
- `Notification`

Important tenant rule: every organization-owned row carries `organizationId`, and every repository method accepts the authenticated tenant context. Do not rely on a UI filter. In PostgreSQL, add composite indexes such as `(organizationId, id)`, `(organizationId, serviceId, sessionDate)`, and `(organizationId, email)`; consider PostgreSQL Row Level Security for defense in depth.

Example production endpoints:

```text
POST /api/auth/register-organization
POST /api/auth/login
GET  /api/organizations/:orgSlug/services/:serviceSlug
POST /api/services/:serviceId/join
GET  /api/queues/:sessionId
POST /api/queues/:sessionId/call-next
POST /api/tokens/:tokenId/complete
POST /api/tokens/:tokenId/skip
POST /api/tokens/:tokenId/priority-request
POST /api/tokens/:tokenId/priority-verify
GET  /api/analytics
```

For state changes such as Call Next, Complete, Skip, and Pause, perform the authorization check and database mutation in one transaction, then broadcast a tenant-scoped Socket.IO event such as `queue.updated` only to rooms the authenticated user is allowed to join. Customers should receive a public service/session room that contains no cross-tenant data.

## Security notes for production

- Hash passwords with Argon2id or bcrypt; never store plaintext passwords
- Use short-lived access tokens plus refresh-token rotation, or secure HTTP-only session cookies
- Resolve `organizationId` from the authenticated principal, not from a client-supplied body field
- Validate payloads with Zod or Joi on every endpoint
- Authorize admin, staff, and public actions separately
- Keep database credentials and JWT secrets in environment variables
- Enable HTTPS, secure cookies, CSRF protection where applicable, and rate limiting on login/join endpoints
- Use idempotency keys or a transaction/unique constraint to prevent duplicate joins under concurrent requests
- Keep priority as a staff-approved transition; customer input is only a request
- Keep a manual fallback for service delivery during an internet/server outage

## AWS deployment path

AWS is useful here when the platform needs multiple organizations and concurrent live users, not as decoration:

- **ECS Fargate or App Runner** for the API and web service without managing servers
- **RDS PostgreSQL** for relational tenant, schedule, queue, and service-record data
- **ElastiCache Redis** for Socket.IO scaling, short-lived locks, and rate limiting
- **S3 + CloudFront** for the static frontend and downloadable QR assets
- **Secrets Manager** for database credentials and JWT/session secrets
- **CloudWatch** for API latency, queue-action errors, and worker health

Start with one API service, RDS PostgreSQL, and a managed HTTPS domain. Add Redis only when horizontal Socket.IO/API scaling is needed.

## Files

- `index.html` — static entry point
- `styles.css` — responsive visual system and layouts
- `app.js` — routing, local data model, shared queue API client, forms, queue logic, QR generation, admin/staff/customer flows
- `server.js` — minimal same-origin shared service/queue API and JSON persistence for cross-device customer participation
- `qrcode-vendor.js` — bundled QR encoder used to generate real scannable codes
- `README.md` — setup, architecture, API, schema, security, and deployment notes

'use strict';

/**
 * Auth & session tests — Requirement 1 acceptance criteria.
 *
 * The admin model is mocked so these tests run without a live MySQL. A real
 * bcrypt hash is used for the seeded admin so the credential-verification path
 * (bcryptjs.compare) is genuinely exercised (Requirement 1.5).
 */

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');

// Mock the admin model before requiring the app.
jest.mock('../src/models/admin');
const adminModel = require('../src/models/admin');

const createApp = require('../src/app');

const ADMIN = {
  id: 1,
  username: 'admin',
  password_hash: bcrypt.hashSync('correct-horse', 10),
  created_at: '2024-01-01 00:00:00',
};

/** Extract the hidden _csrf token from a login page HTML body. */
function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  return match ? match[1] : null;
}

/** GET /login and return { agent, token } sharing one session cookie. */
async function loginPage(app) {
  const agent = request.agent(app);
  const res = await agent.get('/login');
  return { agent, token: extractCsrf(res.text), res };
}

let app;

beforeEach(() => {
  jest.clearAllMocks();
  adminModel.findByUsername.mockImplementation(async (username) =>
    username === ADMIN.username ? ADMIN : null
  );
  app = createApp();
});

describe('Requirement 1.1 — protected routes redirect when unauthenticated', () => {
  test('GET / redirects to /login when not logged in', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('Requirement 1.2 — correct credentials create a session and redirect to dashboard', () => {
  test('valid login sets session and reaches / afterwards', async () => {
    const { agent, token } = await loginPage(app);

    const login = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'correct-horse', _csrf: token });

    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/');

    // The session cookie is now authenticated; the dashboard is reachable.
    const dash = await agent.get('/');
    expect(dash.status).toBe(200);
    expect(dash.text).toContain('Dashboard');
  });
});

describe('Requirement 1.3 — wrong credentials re-render login with error, no session', () => {
  test('wrong password is rejected and no session is created', async () => {
    const { agent, token } = await loginPage(app);

    const login = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'wrong-password', _csrf: token });

    expect(login.status).toBe(401);
    expect(login.text).toContain('Invalid username or password');

    // Still unauthenticated: dashboard redirects to /login.
    const dash = await agent.get('/');
    expect(dash.status).toBe(302);
    expect(dash.headers.location).toBe('/login');
  });

  test('unknown username is rejected', async () => {
    const { agent, token } = await loginPage(app);

    const login = await agent
      .post('/login')
      .type('form')
      .send({ username: 'nobody', password: 'whatever', _csrf: token });

    expect(login.status).toBe(401);
    expect(login.text).toContain('Invalid username or password');
  });
});

describe('Requirement 1.4 — logout destroys the session and redirects to /login', () => {
  test('after logout the dashboard is no longer reachable', async () => {
    const { agent, token } = await loginPage(app);

    await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'correct-horse', _csrf: token });

    // Grab a fresh CSRF token from an authenticated page for the logout POST.
    const dash = await agent.get('/');
    const logoutToken = extractCsrf(dash.text);

    const logout = await agent.post('/logout').type('form').send({ _csrf: logoutToken });
    expect(logout.status).toBe(302);
    expect(logout.headers.location).toBe('/login');

    // Session cleared → dashboard redirects again.
    const after = await agent.get('/');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/login');
  });
});

describe('Requirement 1.6 — state-changing routes are CSRF protected', () => {
  test('POST /login without a CSRF token is rejected 403', async () => {
    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'correct-horse' });

    expect(res.status).toBe(403);
  });

  test('POST /login with a wrong CSRF token is rejected 403', async () => {
    const { agent } = await loginPage(app);

    const res = await agent
      .post('/login')
      .type('form')
      .send({ username: 'admin', password: 'correct-horse', _csrf: 'bogus-token' });

    expect(res.status).toBe(403);
  });

  test('login page exposes a CSRF token', async () => {
    const { token } = await loginPage(app);
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });
});

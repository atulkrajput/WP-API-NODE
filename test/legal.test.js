'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';

const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../src/models/admin');
jest.mock('../src/models/dataDeletion');
jest.mock('../src/models/contact');
jest.mock('../src/models/inboundMessage');

const adminModel = require('../src/models/admin');
const dataDeletion = require('../src/models/dataDeletion');
const createApp = require('../src/app');

const ADMIN = { id: 1, username: 'admin', password_hash: bcrypt.hashSync('pw', 4) };
const csrfOf = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

async function loggedIn(app) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  await agent.post('/login').type('form').send({ username: 'admin', password: 'pw', _csrf: csrfOf(page.text) });
  return agent;
}

let app;
beforeEach(() => {
  jest.clearAllMocks();
  adminModel.findByUsername.mockImplementation(async (u) => (u === 'admin' ? ADMIN : null));
  app = createApp();
});

describe('public legal pages (Meta app settings URLs)', () => {
  test.each([
    ['/privacy-policy', 'Privacy Policy'],
    ['/terms', 'Terms of Service'],
    ['/data-deletion', 'Data Deletion Instructions'],
  ])('%s loads without login', async (path, heading) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toContain(heading);
    // Each page links to the other two.
    expect(res.text).toContain('href="/privacy-policy"');
    expect(res.text).toContain('href="/terms"');
    expect(res.text).toContain('href="/data-deletion"');
  });

  test('data deletion page explains STOP, how to request, and the 30-day timeline', async () => {
    const res = await request(app).get('/data-deletion');
    expect(res.text).toMatch(/Reply <strong>STOP<\/strong>/);
    expect(res.text).toContain('letsbuild@dneconsultants.com');
    expect(res.text).toMatch(/30 days/);
  });

  test('login page links to all legal pages', async () => {
    const res = await request(app).get('/login');
    expect(res.text).toContain('href="/terms"');
    expect(res.text).toContain('href="/data-deletion"');
  });
});

describe('POST /inbox/:e164/delete-data', () => {
  const url = '/inbox/' + encodeURIComponent('+14155550123') + '/delete-data';

  test('requires login', async () => {
    const res = await request(app).post(url);
    expect([302, 403]).toContain(res.status);
    expect(dataDeletion.deleteNumberData).not.toHaveBeenCalled();
  });

  test('refuses unless the number is typed to confirm', async () => {
    const agent = await loggedIn(app);
    const page = await agent.get('/login');
    const token = csrfOf((await agent.get('/inbox')).text) || csrfOf(page.text);
    const res = await agent.post(url).type('form').send({ _csrf: token, confirm: '+1 415 555 9999' });
    expect(res.status).toBe(302);
    expect(dataDeletion.deleteNumberData).not.toHaveBeenCalled();
  });

  test('deletes when the typed number matches (any formatting)', async () => {
    dataDeletion.deleteNumberData.mockResolvedValue({
      messages: 2, inbound: 1, validations: 0, webhookEvents: 1, callbacks: 0, bulkItems: 0, contact: 'deleted',
    });
    const agent = await loggedIn(app);
    const token = csrfOf((await agent.get('/inbox')).text);
    const res = await agent.post(url).type('form').send({ _csrf: token, confirm: '+1 (415) 555-0123' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/inbox');
    expect(dataDeletion.deleteNumberData).toHaveBeenCalledWith('+14155550123');
  });
});

import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';

// No database, dotenv or real session-store initialization in these HTTP tests.
vi.mock('../src/session-store.js', async () => {
  const { Store } = await import('express-session');
  return { SharedMongoStore: class extends Store {} };
});
import { createApp } from '../src/app.js';

function app(NODE_ENV: 'development' | 'test' | 'production', CORS_ORIGIN = 'http://localhost:5173') {
  const config = loadConfig({
    NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1/unused_origin_tests',
    SESSION_SECRET: 'origin-tests-only-secret-at-least-32-characters', CORS_ORIGIN,
  });
  return createApp({ ...config, NODE_ENV }).app;
}

describe('Garde Origin et CORS utilisent la même règle', () => {
  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'])('reflète exactement %s en développement', async origin => {
    const service = app('development');
    const response = await request(service).get('/api/health').set('Origin', origin).expect(200);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers.vary).toContain('Origin');
    const preflight = await request(service).options('/api/decks').set('Origin', origin)
      .set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type').expect(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(origin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    expect(preflight.headers['access-control-allow-headers']).toBe('content-type');
  });

  it.each(['development', 'test', 'production'] as const)('refuse les origines hostiles pour lectures, mutations et préflight en %s', async mode => {
    const service = app(mode);
    for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:5174', 'http://192.168.1.10:5173']) {
      for (const method of ['get', 'post', 'options'] as const) {
        const response = await request(service)[method]('/api/health').set('Origin', origin).send().expect(403);
        expect(response.body).toEqual({ message: 'Origine non autorisée.' });
        expect(response.headers['access-control-allow-origin']).toBeUndefined();
      }
    }
  });

  it.each(['test', 'production'] as const)('reste exact en %s', async mode => {
    const service = app(mode);
    const response = await request(service).get('/api/health').set('Origin', 'http://localhost:5173').expect(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    for (const origin of ['http://127.0.0.1:5173', 'http://[::1]:5173']) {
      await request(service).get('/api/health').set('Origin', origin).expect(403);
      await request(service).options('/api/decks').set('Origin', origin).set('Access-Control-Request-Method', 'POST').expect(403);
    }
  });

  it('ne fait pas exception pour une configuration distante en développement', async () => {
    await request(app('development', 'http://app.example:5173')).get('/api/health')
      .set('Origin', 'http://127.0.0.1:5173').expect(403);
  });

  it('autorise les clients sans Origin sans inventer une origine CORS', async () => {
    const response = await request(app('development')).get('/api/health').expect(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { migrate, pool, seedBrandFromEnv } from './db';
import { attachUser } from './middleware';
import { authRouter } from './routes/auth';
import { leadsRouter } from './routes/leads';
import { sessionsRouter } from './routes/sessions';
import { callsRouter } from './routes/calls';
import { dashboardRouter } from './routes/dashboard';
import { settingsRouter } from './routes/settings';
import { brandRouter } from './routes/brand';
import { voiceRouter } from './routes/voice';

const app = express();
app.set('trust proxy', 1);

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(cookieParser());
app.use(attachUser);

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, db: 'up', version: '0.1.0' });
  } catch (e: any) {
    res.status(500).json({ ok: false, db: 'down', error: e?.message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/calls', callsRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/brand', brandRouter);
app.use('/api/voice', voiceRouter);

// Built frontend (production / docker)
const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err?.status || 500;
  if (status >= 500) console.error('[api]', err);
  res.status(status).json({ error: err?.message || 'Something went wrong' });
});

async function main() {
  await migrate();
  await seedBrandFromEnv();
  app.listen(config.port, () => {
    console.log(`[api] listening on :${config.port} (canonical url ${config.publicUrl || 'from request host'})`);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});

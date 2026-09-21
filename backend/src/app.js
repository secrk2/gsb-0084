import express from 'express';
import cors from 'cors';
import appsRouter from './routes/apps.js';
import formsRouter from './routes/forms.js';
import submissionsRouter from './routes/submissions.js';
import activityRouter from './routes/activity.js';
import attachmentsRouter, { ensureUploadDir } from './routes/attachments.js';
import flowsRouter from './routes/flows.js';
import instancesRouter from './routes/instances.js';
import { USERS } from './users.js';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
  app.get('/api/users', (req, res) => res.json(USERS));
  app.use('/api/apps', appsRouter);
  app.use('/api/forms', formsRouter);
  app.use('/api/submissions', submissionsRouter);
  app.use('/api/activity', activityRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api/flows', flowsRouter);
  app.use('/api/instances', instancesRouter);

  app.use((req, res) => res.status(404).json({ message: `路径不存在：${req.method} ${req.path}` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (err?.type === 'entity.too.large') {
      return res.status(413).json({ message: '提交数据过大（超过 2MB）' });
    }
    res.status(500).json({ message: err?.message || '服务器内部错误' });
  });

  return app;
}

export async function prepareStorage() {
  await ensureUploadDir();
}

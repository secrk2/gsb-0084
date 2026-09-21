import { Router } from 'express';
import multer from 'multer';
import { readdir, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { pool } from '../db.js';
import { config } from '../config.js';

const r = Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 20).replace(/[^\w.]/g, '');
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 5 } });

r.post('/', upload.array('files', 5), async (req, res, next) => {
  try {
    const out = [];
    for (const f of req.files || []) {
      const { rows } = await pool.query(
        `INSERT INTO attachments(stored_name, origin_name, mime_type, size_bytes)
         VALUES ($1,$2,$3,$4) RETURNING id, origin_name, mime_type, size_bytes, uploaded_at`,
        [f.filename, f.originalname, f.mimetype, f.size],
      );
      out.push(rows[0]);
    }
    res.status(201).json(out);
  } catch (e) { next(e); }
});

r.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attachments WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message: '附件不存在' });
    const a = rows[0];
    const full = path.join(config.uploadDir, a.stored_name);
    if (!existsSync(full)) return res.status(410).json({ message: '附件文件已丢失' });
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.origin_name)}`);
    createReadStream(full).pipe(res);
  } catch (e) { next(e); }
});

export async function ensureUploadDir() {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(config.uploadDir, { recursive: true });
}

// 测试环境清理用
export async function _cleanUploads() {
  try {
    for (const f of await readdir(config.uploadDir)) {
      await rm(path.join(config.uploadDir, f), { force: true });
    }
  } catch { /* ignore */ }
}

export default r;

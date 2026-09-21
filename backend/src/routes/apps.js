import { Router } from 'express';
import { pool } from '../db.js';
import { cacheDel } from '../redis.js';

const r = Router();

r.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.name, a.description, a.icon, a.created_at,
              (SELECT count(*) FROM forms f WHERE f.app_id = a.id)::int AS form_count,
              (SELECT count(*) FROM submissions s JOIN forms f ON f.id = s.form_id
                 WHERE f.app_id = a.id)::int AS submission_count,
              (SELECT count(*) FROM submissions s JOIN forms f ON f.id = s.form_id
                 WHERE f.app_id = a.id AND s.created_at >= date_trunc('day', now()))::int AS today_count
       FROM apps a ORDER BY a.id`,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

r.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: '应用名称必填' });
    const { rows } = await pool.query(
      `INSERT INTO apps(name, description, icon) VALUES ($1,$2,$3)
       RETURNING id, name, description, icon, created_at`,
      [name, String(req.body.description || ''), String(req.body.icon || 'app').slice(0, 32)],
    );
    await cacheDel('activity:overview');
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

export default r;

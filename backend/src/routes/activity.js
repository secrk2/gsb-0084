import { Router } from 'express';
import { pool } from '../db.js';
import { cacheGet, cacheSet } from '../redis.js';

const r = Router();

r.get('/overview', async (req, res, next) => {
  try {
    const cached = await cacheGet('activity:overview');
    if (cached) return res.json({ ...cached, cached: true });

    const { rows: kpiRows } = await pool.query(
      `SELECT
         (SELECT count(*) FROM apps)::int AS app_count,
         (SELECT count(*) FROM forms)::int AS form_count,
         (SELECT count(*) FROM submissions)::int AS submission_count,
         (SELECT count(*) FROM submissions WHERE created_at >= date_trunc('day', now()))::int AS today_submission_count,
         (SELECT count(*) FROM validation_errors WHERE occurred_at >= date_trunc('day', now()))::int AS today_error_count`,
    );
    const kpi = kpiRows;

    // 校验失败集中在哪些字段（近 7 天 Top 字段）
    const { rows: fieldHotspots } = await pool.query(
      `SELECT ve.form_id, f.name AS form_name, ve.field_key, ve.field_label,
              count(*)::int AS error_count,
              max(ve.occurred_at) AS last_occurred_at
       FROM validation_errors ve
       JOIN forms f ON f.id = ve.form_id
       WHERE ve.occurred_at >= now() - interval '7 days'
       GROUP BY ve.form_id, f.name, ve.field_key, ve.field_label
       ORDER BY error_count DESC, ve.field_key
       LIMIT 10`,
    );

    // 各应用今日提交
    const { rows: perApp } = await pool.query(
      `SELECT a.id, a.name,
              count(s.id)::int AS today_count
       FROM apps a
       LEFT JOIN forms f ON f.app_id = a.id
       LEFT JOIN submissions s ON s.form_id = f.id AND s.created_at >= date_trunc('day', now())
       GROUP BY a.id, a.name ORDER BY today_count DESC, a.id`,
    );

    // 近 7 天提交趋势
    const { rows: trend } = await pool.query(
      `SELECT to_char(d.day, 'MM-DD') AS label,
              COALESCE(count(s.id), 0)::int AS submission_count,
              COALESCE((SELECT count(*) FROM validation_errors v
                        WHERE v.occurred_at >= d.day AND v.occurred_at < d.day + interval '1 day'),0)::int AS error_count
       FROM generate_series(date_trunc('day', now()) - interval '6 days',
                            date_trunc('day', now()), interval '1 day') d(day)
       LEFT JOIN submissions s ON s.created_at >= d.day AND s.created_at < d.day + interval '1 day'
       GROUP BY d.day ORDER BY d.day`,
    );

    const body = {
      ...kpi[0],
      fieldHotspots,
      perAppToday: perApp,
      trend,
      generatedAt: new Date().toISOString(),
    };
    await cacheSet('activity:overview', body);
    res.json({ ...body, cached: false });
  } catch (e) { next(e); }
});

/** 表单级最近提交记录（预览/验证用） */
r.get('/recent', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.form_id, f.name AS form_name, a.name AS app_name, s.data, s.created_at
       FROM submissions s JOIN forms f ON f.id = s.form_id JOIN apps a ON a.id = f.app_id
       ORDER BY s.id DESC LIMIT 15`,
    );
    res.json(rows);
  } catch (e) { next(e); }
});

export default r;

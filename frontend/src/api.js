import { actorState } from './actor.js';

const BASE = '/api';

async function request(method, url, body, isForm = false) {
  const opts = { method, headers: {} };
  if (actorState.current) opts.headers['X-Actor'] = actorState.current;
  if (body !== undefined) {
    if (isForm) {
      opts.body = body; // FormData：让浏览器自行设置 Content-Type
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(BASE + url, opts);
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
  put: (u, b) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
  upload: (u, formData) => request('POST', u, formData, true),
};

// ---- 基础接口 ----
export const fetchApps = () => api.get('/apps');
export const createApp = (payload) => api.post('/apps', payload);

export const fetchForms = (appId) => api.get(`/forms${appId ? `?appId=${appId}` : ''}`);
export const fetchForm = (id) => api.get(`/forms/${id}`);
export const createForm = (payload) => api.post('/forms', payload);
export const updateForm = (id, payload) => api.put(`/forms/${id}`, payload);
export const checkDeleteField = (id, path) => api.post(`/forms/${id}/fields/check-delete`, { path });
export const removeField = (id, path) => api.post(`/forms/${id}/fields/remove`, { path });

export const fetchSubmissions = (formId) => api.get(`/submissions?formId=${formId}`);
export const submitForm = (formId, data) => api.post('/submissions', { form_id: formId, data });
export const resubmitForm = (id, data) => api.put(`/submissions/${id}/resubmit`, { data });
export const previewResubmitDiff = (id, data) => api.post(`/submissions/${id}/resubmit/diff`, { data });

export const fetchOverview = () => api.get('/activity/overview');
export const fetchRecent = () => api.get('/activity/recent');

export const uploadFiles = (files) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return api.upload('/attachments', fd);
};
export const attachmentUrl = (id) => `${BASE}/attachments/${id}`;

// ---- 人员 ----
export const fetchUsers = () => api.get('/users');

// ---- 流程定义 ----
export const fetchFlows = (formId) => api.get(`/flows?formId=${formId}`);
export const fetchActiveFlow = (formId) => api.get(`/flows/active?formId=${formId}`);
export const createFlow = (payload) => api.post('/flows', payload);
export const fetchFlow = (id) => api.get(`/flows/${id}`);
export const updateFlow = (id, payload) => api.put(`/flows/${id}`, payload);
export const publishFlow = (id) => api.post(`/flows/${id}/publish`);
export const disableFlow = (id) => api.post(`/flows/${id}/disable`);
export const newFlowVersion = (id) => api.post(`/flows/${id}/new-version`);

// ---- 流程实例 / 审批 ----
export const fetchTodo = (assignee) => api.get(`/instances/todo?assignee=${encodeURIComponent(assignee)}`);
export const fetchInstances = (params = {}) => {
  const q = new URLSearchParams();
  if (params.formId) q.set('formId', params.formId);
  if (params.status) q.set('status', params.status);
  const s = q.toString();
  return api.get(`/instances${s ? `?${s}` : ''}`);
};
export const fetchInstanceDetail = (submissionId) => api.get(`/instances/by-submission/${submissionId}`);
export const approveTask = (taskId, comment) => api.post(`/instances/tasks/${taskId}/approve`, { comment });
export const rejectTask = (taskId, comment) => api.post(`/instances/tasks/${taskId}/reject`, { comment });
export const returnTask = (taskId, target, comment) => api.post(`/instances/tasks/${taskId}/return`, { target, comment });

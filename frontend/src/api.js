const BASE = '/api';

async function request(method, url, body, isForm = false) {
  const opts = { method, headers: {} };
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

// ---- 业务接口 ----
export const fetchApps = () => api.get('/apps');
export const createApp = (payload) => api.post('/apps', payload);

export const fetchForms = (appId) => api.get(`/forms${appId ? `?appId=${appId}` : ''}`);
export const fetchForm = (id) => api.get(`/forms/${id}`);
export const createForm = (payload) => api.post('/forms', payload);
export const updateForm = (id, payload) => api.put(`/forms/${id}`, payload);
export const checkDeleteField = (id, path) => api.post(`/forms/${id}/fields/check-delete`, { path });
export const removeField = (id, path) => api.post(`/forms/${id}/fields/remove`, { path });

export const fetchSubmissions = (formId) => api.get(`/submissions?formId=${formId}`);
export const submitForm = (formId, data, actor) => api.post('/submissions', { form_id: formId, data, created_by: actor });
export const resubmitForm = (id, data, actor) => api.put(`/submissions/${id}/resubmit`, { data, created_by: actor });
export const fetchSubmission = (id) => api.get(`/submissions/${id}`);

// ---- 流程设计 ----
export const fetchFlowDesign = (formId) => api.get(`/flows/form/${formId}/design`);
export const saveFlowDraft = (formId, payload) => api.put(`/flows/form/${formId}/draft`, payload);
export const publishFlow = (id) => api.post(`/flows/${id}/publish`);
export const unpublishFlow = (id) => api.post(`/flows/${id}/unpublish`);
export const deleteFlowDraft = (id) => api.del(`/flows/${id}`);
export const fetchFlows = (formId) => api.get(`/flows?formId=${formId}`);

// ---- 流程运行 ----
export const fetchInstances = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== null)).toString();
  return api.get(`/instances${q ? `?${q}` : ''}`);
};
export const fetchInstance = (id) => api.get(`/instances/${id}`);
export const fetchTodo = (assignee) => api.get(`/instances/tasks/todo?assignee=${encodeURIComponent(assignee)}`);
export const approveTask = (taskId, actor, comment) => api.post(`/instances/tasks/${taskId}/approve`, { actor, comment });
export const returnTask = (taskId, actor, comment) => api.post(`/instances/tasks/${taskId}/return`, { actor, comment });

export const fetchUsers = () => api.get('/users');

export const fetchOverview = () => api.get('/activity/overview');
export const fetchRecent = () => api.get('/activity/recent');

export const uploadFiles = (files) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return api.upload('/attachments', fd);
};
export const attachmentUrl = (id) => `${BASE}/attachments/${id}`;

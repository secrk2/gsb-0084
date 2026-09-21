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
export const submitForm = (formId, data) => api.post('/submissions', { form_id: formId, data });

export const fetchOverview = () => api.get('/activity/overview');
export const fetchRecent = () => api.get('/activity/recent');

export const uploadFiles = (files) => {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  return api.upload('/attachments', fd);
};
export const attachmentUrl = (id) => `${BASE}/attachments/${id}`;

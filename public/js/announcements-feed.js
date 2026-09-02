/**
 * Announcements Feed — read-only list of active school announcements
 * (the same public.announcements table ccpc-teachers' Announcements
 * module writes to, targeting P10 displays). Guardians/students only
 * ever view here; creation stays admin-only in ccpc-teachers.
 */

let announcementsData = [];

async function loadAnnouncementsFeed() {
  const container = document.getElementById('announcements-section');
  if (!container) return;
  container.innerHTML = `<div class="text-center p-4"><div class="spinner-border text-primary spinner-border-sm"></div><span class="ms-2 fw-700">Loading announcements...</span></div>`;
  try {
    const res = await portalFetch('get_active_announcements', {});
    if (res.result !== 'success') {
      container.innerHTML = `<div class="alert alert-danger rounded-4 fw-800">${res.message || 'Could not load announcements.'}</div>`;
      return;
    }
    announcementsData = res.announcements || [];
    renderAnnouncementsFeed();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger rounded-4 fw-800">Failed to load announcements.</div>`;
  }
}

function renderAnnouncementsFeed() {
  const container = document.getElementById('announcements-section');
  if (!container) return;

  if (announcementsData.length === 0) {
    container.innerHTML = `<div class="card shadow-lg text-center p-5"><i class="bi bi-megaphone text-muted display-4 mb-3"></i><h3 class="h4">No Announcements</h3><p class="text-muted">Nothing active right now — check back later.</p></div>`;
    return;
  }

  const cards = announcementsData.map(a => {
    const dt = new Date(a.created_at);
    const dateStr = dt.toLocaleDateString('en-BD', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-BD', { hour: '2-digit', minute: '2-digit' });
    const player = a.file_url
      ? `<audio controls src="${a.file_url}" class="w-100 mt-2" style="height:38px"></audio>`
      : `<p class="text-muted small fst-italic mt-2 mb-0"><i class="bi bi-chat-square-text me-1"></i>Text announcement — no audio</p>`;
    return `
      <div class="card shadow-sm border-0 rounded-4 mb-3">
        <div class="card-body p-3">
          <div class="d-flex align-items-start gap-2">
            <div class="rounded-circle bg-primary-subtle text-primary d-flex align-items-center justify-content-center flex-shrink-0" style="width:38px;height:38px">
              <i class="bi bi-megaphone-fill"></i>
            </div>
            <div class="flex-grow-1 min-w-0">
              <p class="fw-800 mb-0">${_escAnn(a.title)}</p>
              <p class="text-muted small fw-600 mb-0">${dateStr} &middot; ${timeStr}</p>
              ${player}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<h2 class="ccpc-page-title">School <em>Announcements</em></h2>${cards}`;
}

function _escAnn(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.AnnouncementsFeed = { loadAnnouncementsFeed };

/**
 * Announcements Feed — two kinds reach a guardian's portal:
 *   'general' -> school-wide banner, rendered as a carousel using the same
 *     visual component as the login page's notice carousel (title/subtitle/
 *     body, HTML allowed, no audio by design).
 *   'student' -> targeted at this specific student only, rendered as a card
 *     (audio player or "text only") same as before.
 * 'device' (P10 speaker broadcasts) never reach here — those play over
 * campus speakers, they aren't a portal message. Creation stays admin-only
 * in ccpc-teachers.
 */

let ANN_GENERAL_SLIDES = [];
let annGenIdx = 0;
let annGenTimer = null;
let ANN_PERSONAL = [];

async function loadAnnouncementsFeed() {
  const container = document.getElementById('announcements-section');
  if (!container) return;
  container.innerHTML = `<div class="text-center p-4"><div class="spinner-border text-primary spinner-border-sm"></div><span class="ms-2 fw-700">Loading announcements...</span></div>`;
  try {
    const res = await portalFetch('get_active_announcements', { student_id: loggedInStudent.student_id });
    if (res.result !== 'success') {
      container.innerHTML = `<div class="alert alert-danger rounded-4 fw-800">${res.message || 'Could not load announcements.'}</div>`;
      return;
    }
    const all = res.announcements || [];
    ANN_GENERAL_SLIDES = all.filter(a => a.announcement_type === 'general');
    ANN_PERSONAL = all.filter(a => a.announcement_type === 'student');
    renderAnnouncementsFeed();
  } catch (err) {
    container.innerHTML = `<div class="alert alert-danger rounded-4 fw-800">Failed to load announcements.</div>`;
  }
}

function renderAnnouncementsFeed() {
  const container = document.getElementById('announcements-section');
  if (!container) return;

  if (ANN_GENERAL_SLIDES.length === 0 && ANN_PERSONAL.length === 0) {
    container.innerHTML = `<h2 class="ccpc-page-title">School <em>Announcements</em></h2><div class="card shadow-lg text-center p-5"><i class="bi bi-megaphone text-muted display-4 mb-3"></i><h3 class="h4">No Announcements</h3><p class="text-muted">Nothing active right now — check back later.</p></div>`;
    return;
  }

  const carouselHtml = ANN_GENERAL_SLIDES.length ? `
    <div id="ann-general-carousel" class="ann-carousel">
      <div class="notice-viewport">
        <div class="notice-track" id="ann-general-track"></div>
        ${ANN_GENERAL_SLIDES.length > 1 ? `
        <button type="button" class="notice-arrow notice-arrow-l" onclick="annGeneralGo(-1)"><i class="bi bi-chevron-left"></i></button>
        <button type="button" class="notice-arrow notice-arrow-r" onclick="annGeneralGo(1)"><i class="bi bi-chevron-right"></i></button>` : ''}
      </div>
      <div class="notice-dots" id="ann-general-dots"></div>
    </div>` : '';

  const personalCards = ANN_PERSONAL.map(a => {
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
              <i class="bi bi-person-lines-fill"></i>
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

  const personalHtml = ANN_PERSONAL.length
    ? `<h3 class="h6 fw-800 mt-4 mb-2"><i class="bi bi-person-lines-fill me-1"></i>For You</h3>${personalCards}`
    : '';

  container.innerHTML = `<h2 class="ccpc-page-title">School <em>Announcements</em></h2>${carouselHtml}${personalHtml}`;

  if (ANN_GENERAL_SLIDES.length) {
    const track = document.getElementById('ann-general-track');
    const dots = document.getElementById('ann-general-dots');
    // Same trust model as the login notice carousel: admin-authored HTML,
    // rendered unescaped by design.
    track.innerHTML = ANN_GENERAL_SLIDES.map(a => `
      <div class="notice-slide">
        ${a.title ? `<div class="notice-slide-title">${a.title}</div>` : ''}
        ${a.subtitle ? `<div class="notice-slide-subtitle">${a.subtitle}</div>` : ''}
        ${a.body ? `<div class="notice-slide-body">${a.body}</div>` : ''}
      </div>`).join('');
    dots.innerHTML = ANN_GENERAL_SLIDES.length > 1
      ? ANN_GENERAL_SLIDES.map((_, i) => `<button type="button" class="notice-dot" onclick="annGeneralGoTo(${i})"></button>`).join('')
      : '';
    annGenIdx = 0;
    annGeneralRender();
    if (ANN_GENERAL_SLIDES.length > 1) annGeneralStartAuto();
    let touchX = null;
    const viewport = document.querySelector('#ann-general-carousel .notice-viewport');
    if (viewport) {
      viewport.addEventListener('touchstart', e => { touchX = e.touches[0].clientX; }, { passive: true });
      viewport.addEventListener('touchend', e => {
        if (touchX === null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        if (Math.abs(dx) > 40) annGeneralGo(dx > 0 ? -1 : 1);
        touchX = null;
      }, { passive: true });
    }
  }
}

function annGeneralRender() {
  const track = document.getElementById('ann-general-track');
  if (track) track.style.transform = `translateX(-${annGenIdx * 100}%)`;
  document.querySelectorAll('#ann-general-dots .notice-dot').forEach((d, i) => d.classList.toggle('active', i === annGenIdx));
}

function annGeneralGo(delta) {
  if (ANN_GENERAL_SLIDES.length === 0) return;
  annGenIdx = (annGenIdx + delta + ANN_GENERAL_SLIDES.length) % ANN_GENERAL_SLIDES.length;
  annGeneralRender();
  annGeneralStartAuto();
}

function annGeneralGoTo(i) { annGenIdx = i; annGeneralRender(); annGeneralStartAuto(); }

function annGeneralStartAuto() {
  if (annGenTimer) clearInterval(annGenTimer);
  if (ANN_GENERAL_SLIDES.length > 1) annGenTimer = setInterval(() => annGeneralGo(1), 6000);
}

function _escAnn(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.AnnouncementsFeed = { loadAnnouncementsFeed };

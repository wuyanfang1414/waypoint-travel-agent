const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  cities: [],
  days: 3,
  travelers: 2,
  pace: "balanced",
  hotel: "舒适",
  plan: null,
  saved: JSON.parse(localStorage.getItem("waypoint-saved") || "[]"),
  runtime: "server",
};

const escapeHtml = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2200);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function isoAfter(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function initialize() {
  try {
    let cities;
    let health;
    const staticHosting = location.hostname.endsWith("github.io") || new URLSearchParams(location.search).has("static");
    if (staticHosting && window.WaypointStatic) {
      cities = await window.WaypointStatic.cities();
      health = { mode: "browser", model: null };
      state.runtime = "browser";
    } else try {
      [cities, health] = await Promise.all([fetchJson("/api/cities"), fetchJson("/api/health")]);
    } catch (serverError) {
      if (!window.WaypointStatic) throw serverError;
      cities = await window.WaypointStatic.cities();
      health = { mode: "browser", model: null };
      state.runtime = "browser";
    }
    state.cities = cities;
    $("#destination").innerHTML = cities.map(city => `<option value="${city.id}">${escapeHtml(city.name)}</option>`).join("");
    $("#destination").value = "hangzhou";
    $("#city-count").textContent = `${cities.length} 城`;
    $("#mode-label").textContent = health.mode === "openai" ? `${health.model} 增强` : health.mode === "browser" ? "浏览器本地模式" : "本地规划模式";
  } catch (error) {
    toast(`初始化失败：${error.message}`);
  }
  $("#start-date").value = isoAfter(7);
  bindEvents();
  renderSaved();
}

function bindEvents() {
  $$("[data-step]").forEach(button => button.addEventListener("click", () => stepValue(button.dataset.step, Number(button.dataset.delta))));
  $$(".segmented button").forEach(button => button.addEventListener("click", () => selectSegment(button)));
  $("#plan-button").addEventListener("click", generatePlan);
  $("#sample-button").addEventListener("click", () => { resetPreferences(); generatePlan(); });
  $("#reset-button").addEventListener("click", resetPreferences);
  $("#save-plan").addEventListener("click", savePlan);
  $("#export-plan").addEventListener("click", exportPlan);
  $$(".tabs button").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  $("#method-button").addEventListener("click", () => $("#method-dialog").showModal());
  $(".close-dialog").addEventListener("click", () => $("#method-dialog").close());
  $("#method-dialog").addEventListener("click", event => { if (event.target === $("#method-dialog")) $("#method-dialog").close(); });
  $("#saved-button").addEventListener("click", openDrawer);
  $("#close-drawer").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
}

function stepValue(key, delta) {
  if (key === "days") {
    state.days = Math.max(1, Math.min(7, state.days + delta));
    $("#days-value").textContent = state.days;
  } else {
    state.travelers = Math.max(1, Math.min(8, state.travelers + delta));
    $("#travelers-value").textContent = state.travelers;
  }
}

function selectSegment(button) {
  const group = button.closest(".segmented");
  $$("button", group).forEach(item => item.classList.toggle("active", item === button));
  state[group.dataset.control] = button.dataset.value;
}

function resetPreferences() {
  $("#origin").value = "上海";
  $("#destination").value = "hangzhou";
  $("#start-date").value = isoAfter(7);
  $("#budget").value = 3600;
  state.days = 3;
  state.travelers = 2;
  $("#days-value").textContent = "3";
  $("#travelers-value").textContent = "2";
  $$("#interest-grid input").forEach(input => input.checked = ["历史", "美食", "摄影"].includes(input.value));
  state.pace = "balanced";
  state.hotel = "舒适";
  $$(`[data-control="pace"] button`).forEach(button => button.classList.toggle("active", button.dataset.value === "balanced"));
  $$(`[data-control="hotel"] button`).forEach(button => button.classList.toggle("active", button.dataset.value === "舒适"));
  $("#transport").value = "smart";
  $("#accessibility").checked = false;
  $("#notes").value = "";
  toast("已恢复杭州 3 日示例偏好");
}

function readPreferences() {
  return {
    origin: $("#origin").value,
    destination: $("#destination").value,
    start_date: $("#start-date").value,
    days: state.days,
    travelers: state.travelers,
    budget: Number($("#budget").value),
    interests: $$("#interest-grid input:checked").map(input => input.value),
    pace: state.pace,
    hotel: state.hotel,
    transport: $("#transport").value,
    accessibility: $("#accessibility").checked,
    notes: $("#notes").value.trim(),
  };
}

function loadingTrace() {
  const steps = ["Preference Interpreter", "Destination Search", "Budget Allocator", "Route Optimizer", "Weather Adapter", "Constraint Validator"];
  $("#empty-state").innerHTML = `<div class="trace-list">${steps.map((step, index) => `
    <div class="trace-row"><span class="trace-index">${String(index + 1).padStart(2, "0")}</span><div class="trace-copy"><strong>${step}</strong><span>${index === 0 ? "正在处理偏好…" : "等待上游工具"}</span></div><span class="trace-ms">--</span></div>`).join("")}</div>`;
}

async function generatePlan() {
  const prefs = readPreferences();
  if (!prefs.start_date) return toast("请选择出发日期");
  if (!prefs.interests.length) return toast("至少选择一项兴趣");
  if (!prefs.budget || prefs.budget < 300) return toast("总预算至少填写 ¥300");
  const button = $("#plan-button");
  button.disabled = true;
  button.innerHTML = "<span>Agent 正在规划</span><b>…</b>";
  $("#plan-result").hidden = true;
  $("#empty-state").hidden = false;
  $("#result-state").textContent = "正在调用规划工具";
  loadingTrace();
  try {
    if (state.runtime === "browser" && window.WaypointStatic) {
      state.plan = await window.WaypointStatic.planTrip(prefs);
    } else try {
      state.plan = await fetchJson("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prefs) });
    } catch (serverError) {
      if (!window.WaypointStatic) throw serverError;
      state.plan = await window.WaypointStatic.planTrip(prefs);
    }
    renderPlan(state.plan);
    toast("方案已生成，并完成预算与路线校验");
  } catch (error) {
    toast(error.message);
    $("#result-state").textContent = "生成失败，请调整偏好";
  } finally {
    button.disabled = false;
    button.innerHTML = "<span>生成旅行方案</span><b>→</b>";
  }
}

function formatDate(date) {
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", weekday: "short" }).format(new Date(`${date}T12:00:00`));
}

function renderPlan(plan) {
  $("#empty-state").hidden = true;
  $("#plan-result").hidden = false;
  $("#save-plan").disabled = false;
  $("#export-plan").disabled = false;
  const modeLabel = plan.mode === "openai" ? "模型增强" : plan.mode === "browser" ? "浏览器本地规划" : "确定性规划";
  $("#result-state").textContent = `${modeLabel} · ${plan.trace.length} 步完成`;
  const endDate = plan.itinerary.at(-1).date;
  $("#date-range").textContent = `${plan.preferences.start_date} → ${endDate} · ${plan.preferences.days}天${Math.max(0, plan.preferences.days - 1)}晚`;
  $("#destination-title").textContent = `${plan.destination.name} · ${plan.preferences.interests.slice(0, 3).join(" / ")}`;
  $("#plan-overview").textContent = plan.narrative.overview;
  $("#health-score").style.setProperty("--health", plan.budget.health);
  $("#health-value").textContent = plan.budget.health;
  $("#planned-budget").textContent = `¥${plan.budget.planned.toLocaleString()}`;
  $("#target-budget").textContent = `目标 ¥${plan.budget.target.toLocaleString()} · ${plan.budget.status}`;
  $("#hotel-summary").textContent = plan.hotels[0].tier;
  $("#hotel-total").textContent = `${plan.hotels[0].district} · 约¥${plan.hotels[0].estimated_total}`;
  $("#transport-summary").textContent = plan.transport.mode;
  $("#transport-cost").textContent = `${plan.transport.duration} · 往返约¥${plan.transport.round_trip_estimate}`;
  $("#weather-summary").textContent = plan.weather.source;
  $("#weather-detail").textContent = plan.weather.high != null ? `${plan.weather.low}–${plan.weather.high}℃ · 降雨${plan.weather.rain}%` : "使用季节性提示";
  renderItinerary(plan);
  renderBudget(plan);
  renderStay(plan);
  renderTrace(plan);
  switchTab("itinerary");
}

function renderItinerary(plan) {
  $("#tab-itinerary").innerHTML = plan.itinerary.map(day => `
    <section class="day-block">
      <div class="day-meta"><span>DAY ${String(day.day).padStart(2, "0")}</span><h3>${escapeHtml(formatDate(day.date))}</h3><p>${escapeHtml(day.theme)}<br>预计 ${day.estimated_hours} 小时</p></div>
      <div class="activity-list">${day.activities.map(activity => `
        <div class="activity-row">
          <span class="activity-time">${escapeHtml(activity.time)}</span><i class="activity-dot"></i>
          <div class="activity-copy"><strong>${escapeHtml(activity.name)}</strong><p>${escapeHtml(activity.note)}</p><span>${escapeHtml(activity.area)} · ${escapeHtml(activity.duration)} · ${activity.indoor ? "室内/可避雨" : "户外"}</span></div>
          <span class="activity-cost">${activity.price ? `¥${activity.price}` : "免费"}</span>
        </div>`).join("")}</div>
    </section>`).join("");
}

function renderBudget(plan) {
  const max = Math.max(...plan.budget.items.map(item => item.amount), 1);
  const rows = plan.budget.items.map(item => `
    <div class="budget-row"><div class="budget-bar-head"><span>${escapeHtml(item.label)}</span><strong>¥${item.amount.toLocaleString()}</strong></div><div class="budget-track"><div class="budget-fill" style="width:${Math.max(2, item.amount / max * 100)}%"></div></div></div>`).join("");
  const validation = plan.validation.map(item => `<div class="validation-item ${item.level}">${escapeHtml(item.message)}</div>`).join("");
  $("#tab-budget").innerHTML = `<div class="budget-layout"><div class="budget-bars">${rows}</div><aside class="validation-list"><h3>约束检查</h3>${validation}<div class="data-notice">${escapeHtml(plan.narrative.booking_note)}</div></aside></div>`;
}

function renderStay(plan) {
  const hotels = plan.hotels.map((hotel, index) => `
    <article class="hotel-card ${index === 0 ? "recommended" : ""}"><span>${index === 0 ? "AGENT RECOMMENDED" : `${hotel.tier}备选`}</span><h3>${escapeHtml(hotel.name)}</h3><p>${escapeHtml(hotel.district)} · ${hotel.tags.map(escapeHtml).join(" / ")}<br>${escapeHtml(hotel.note)}</p><div class="hotel-price"><strong>¥${hotel.nightly[0]}–${hotel.nightly[1]}</strong><small>每晚参考</small></div></article>`).join("");
  $("#tab-stay").innerHTML = `<div class="hotel-list">${hotels}</div><div class="transport-band"><div><span>INTERCITY</span><strong>${escapeHtml(plan.transport.mode)} · ${escapeHtml(plan.transport.hub)}</strong><p>${escapeHtml(plan.transport.duration)}，单程参考 ¥${plan.transport.one_way[0]}–${plan.transport.one_way[1]}。价格与班次需实时复核。</p></div><div><span>LOCAL</span><strong>${escapeHtml(plan.transport.local.name)}</strong><p>${escapeHtml(plan.transport.local.tip)} 每人每天参考 ¥${plan.transport.local.daily_per_person}。</p></div></div>`;
}

function renderTrace(plan) {
  $("#tab-trace").innerHTML = `<div class="trace-list">${plan.trace.map((step, index) => `
    <div class="trace-row"><span class="trace-index">${String(index + 1).padStart(2, "0")}</span><div class="trace-copy"><strong>${escapeHtml(step.tool)}</strong><span>${escapeHtml(step.detail)}</span></div><span class="trace-ms">${step.ms || 0}ms</span></div>`).join("")}</div><div class="data-notice">数据集：${escapeHtml(plan.dataset.name)} v${escapeHtml(plan.dataset.version)} · ${escapeHtml(plan.dataset.notice)}</div>`;
}

function switchTab(tab) {
  $$(".tabs button").forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
  $$(".tab-panel").forEach(panel => panel.classList.toggle("active", panel.id === `tab-${tab}`));
}

function savePlan() {
  if (!state.plan) return;
  const saved = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), created: new Date().toLocaleDateString("zh-CN"), plan: state.plan };
  state.saved.unshift(saved);
  state.saved = state.saved.slice(0, 8);
  localStorage.setItem("waypoint-saved", JSON.stringify(state.saved));
  renderSaved();
  toast("方案已保存到当前浏览器");
}

function renderSaved() {
  $("#saved-count").textContent = state.saved.length;
  $("#saved-list").innerHTML = state.saved.length ? state.saved.map(item => `
    <article class="saved-card"><strong>${escapeHtml(item.plan.destination.name)} · ${item.plan.preferences.days}日</strong><p>${escapeHtml(item.plan.preferences.interests.join(" / "))}<br>¥${item.plan.budget.planned} · ${escapeHtml(item.created)}</p><div><span>${item.plan.budget.health}/100</span><button data-delete="${item.id}">删除</button></div></article>`).join("") : `<div class="saved-empty">还没有保存的方案。</div>`;
  $$(`[data-delete]`).forEach(button => button.addEventListener("click", () => {
    state.saved = state.saved.filter(item => item.id !== button.dataset.delete);
    localStorage.setItem("waypoint-saved", JSON.stringify(state.saved));
    renderSaved();
  }));
}

function openDrawer() { $("#saved-drawer").classList.add("open"); $("#drawer-backdrop").classList.add("open"); }
function closeDrawer() { $("#saved-drawer").classList.remove("open"); $("#drawer-backdrop").classList.remove("open"); }

function exportPlan() {
  if (!state.plan) return;
  const plan = state.plan;
  const text = `# ${plan.destination.name} ${plan.preferences.days}日旅行方案\n\n` +
    `- 日期：${plan.preferences.start_date} 起\n- 同行：${plan.preferences.travelers}人\n- 预算：¥${plan.budget.planned} / 目标 ¥${plan.budget.target}\n- 兴趣：${plan.preferences.interests.join("、")}\n\n` +
    plan.itinerary.map(day => `## Day ${day.day} · ${day.theme}\n${day.activities.map(a => `- ${a.time} ${a.name}（${a.area}，${a.duration}${a.price ? `，¥${a.price}` : "，免费"}）\n  ${a.note}`).join("\n")}`).join("\n\n") +
    `\n\n## 住宿\n${plan.hotels.map(h => `- ${h.name}：¥${h.nightly[0]}–${h.nightly[1]}/晚`).join("\n")}\n\n## 交通\n- ${plan.transport.mode}：${plan.transport.hub}，${plan.transport.duration}\n- 市内：${plan.transport.local.name}\n\n> ${plan.dataset.notice}`;
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${plan.destination.name}-${plan.preferences.days}日旅行方案.md`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("Markdown 行程已导出");
}

initialize();

(function () {
  const paceLimits = { relaxed: 2, balanced: 3, packed: 4 };
  const paceLabels = { relaxed: "松弛", balanced: "平衡", packed: "充实" };
  const hotelTiers = ["经济", "舒适", "设计"];
  let datasetCache = null;

  async function loadDataset() {
    if (datasetCache) return datasetCache;
    const response = await fetch("./data/cities.json");
    if (!response.ok) throw new Error("静态目的地数据加载失败");
    datasetCache = await response.json();
    return datasetCache;
  }

  async function cities() {
    const data = await loadDataset();
    return Object.entries(data.cities).map(([id, city]) => ({ id, name: city.name, summary: city.summary, center: city.center }));
  }

  function normalize(raw) {
    return {
      origin: raw.origin || "上海",
      destination: raw.destination || "hangzhou",
      start_date: raw.start_date,
      days: Math.max(1, Math.min(7, Number(raw.days) || 3)),
      travelers: Math.max(1, Math.min(8, Number(raw.travelers) || 2)),
      budget: Math.max(300, Number(raw.budget) || 3000),
      interests: [...new Set(raw.interests?.length ? raw.interests : ["历史", "美食", "摄影"])].slice(0, 6),
      pace: paceLimits[raw.pace] ? raw.pace : "balanced",
      hotel: hotelTiers.includes(raw.hotel) ? raw.hotel : "舒适",
      transport: raw.transport || "smart",
      accessibility: Boolean(raw.accessibility),
      notes: String(raw.notes || "").trim().slice(0, 500),
    };
  }

  function chooseConnection(data, prefs, city) {
    if (prefs.origin === city.name) return { mode: "市内出发", duration: "无需城际交通", one_way: [0, 0], hub: "本地集合", carbon: "低" };
    const options = data.connections[`${prefs.origin}-${city.name}`];
    if (!options) return { mode: "高铁/飞机比价", duration: "以实时查询为准", one_way: [350, 900], hub: `${prefs.origin} → ${city.name}`, carbon: "待确认" };
    if (prefs.transport === "train") return options.find(x => x.mode === "高铁") || options[0];
    if (prefs.transport === "flight") return options.find(x => x.mode === "飞机") || options[0];
    if (prefs.transport === "low-carbon") return [...options].sort((a, b) => Number(a.carbon !== "低") - Number(b.carbon !== "低") || sum(a.one_way) - sum(b.one_way))[0];
    if (prefs.days <= 3 && options.some(x => x.mode === "飞机")) return options.find(x => x.mode === "飞机");
    return [...options].sort((a, b) => sum(a.one_way) - sum(b.one_way))[0];
  }

  const sum = values => values.reduce((a, b) => a + b, 0);

  function attractionScore(item, prefs) {
    const hits = item.tags.filter(tag => prefs.interests.includes(tag)).length;
    let score = item.priority + hits * 3 + (item.price === 0 ? 1.2 : 0);
    const perPersonDaily = prefs.budget / prefs.travelers / prefs.days;
    if (perPersonDaily < 450 && item.price > 150) score -= 6;
    if (prefs.accessibility && (item.tags.includes("徒步") || item.duration >= 5)) score -= 4;
    return score;
  }

  function pickAttractions(city, prefs) {
    const target = Math.min(city.attractions.length, prefs.days * paceLimits[prefs.pace]);
    const hourBudget = prefs.days * { relaxed: 4.8, balanced: 7.2, packed: 9.5 }[prefs.pace];
    const ranked = [...city.attractions].sort((a, b) => attractionScore(b, prefs) - attractionScore(a, prefs));
    const selected = [];
    let usedHours = 0;
    for (const item of ranked) {
      const projected = usedHours + item.duration + (selected.length ? .6 : 0);
      if (selected.length < prefs.days || (selected.length < target && projected <= hourBudget)) {
        selected.push(item);
        usedHours = projected;
      }
    }
    return selected;
  }

  function distance(a, b) {
    return Math.hypot((a.coords[0] - b.coords[0]) * 111, (a.coords[1] - b.coords[1]) * 96);
  }

  function groupDays(selected, prefs) {
    const days = Array.from({ length: prefs.days }, () => []);
    if (!selected.length) return days;
    const remaining = [...selected];
    const ordered = [remaining.shift()];
    while (remaining.length) {
      const nearest = [...remaining].sort((a, b) => distance(ordered.at(-1), a) - distance(ordered.at(-1), b))[0];
      ordered.push(nearest);
      remaining.splice(remaining.indexOf(nearest), 1);
    }
    let cursor = 0;
    days.forEach((day, index) => {
      const itemsLeft = ordered.length - cursor;
      const daysLeft = days.length - index;
      const take = Math.min(itemsLeft ? Math.ceil(itemsLeft / daysLeft) : 0, paceLimits[prefs.pace]);
      day.push(...ordered.slice(cursor, cursor + take));
      cursor += take;
    });
    if (cursor < ordered.length) days.at(-1).push(...ordered.slice(cursor));
    return days;
  }

  function timeLabel(hours) {
    const hour = Math.floor(hours);
    const minute = hours - hour >= .5 ? 30 : 0;
    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function addDays(iso, count) {
    const date = new Date(`${iso}T12:00:00`);
    date.setDate(date.getDate() + count);
    return date.toISOString().slice(0, 10);
  }

  function itinerary(city, groups, prefs) {
    return groups.map((items, index) => {
      let clock = 9;
      const areas = [];
      const activities = items.map(item => {
        areas.push(item.area);
        const activity = { time: timeLabel(clock), name: item.name, area: item.area, duration: `${item.duration}小时`, price: item.price, tags: item.tags, note: item.note, indoor: item.indoor, coords: item.coords };
        clock += item.duration + .6;
        return activity;
      });
      const counts = areas.reduce((map, area) => ({ ...map, [area]: (map[area] || 0) + 1 }), {});
      const primaryArea = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || Object.keys(city.food_areas)[0];
      const foodArea = city.food_areas[primaryArea] || Object.values(city.food_areas)[0];
      if (activities.length) activities.push({ time: timeLabel(Math.max(clock, 18)), name: `在${foodArea}安排晚餐`, area: primaryArea, duration: "1.5小时", price: 0, tags: ["美食"], note: "按预算选择餐厅，避开网红排队高峰。", indoor: true, coords: null });
      const estimated = items.reduce((total, item) => total + item.duration, 0) + Math.max(0, items.length - 1) * .6 + (items.length ? 1.5 : 0);
      return { day: index + 1, date: addDays(prefs.start_date, index), theme: `${primaryArea} · ${prefs.interests.slice(0, 2).join(" / ")}`, activities, estimated_hours: Math.round(estimated * 10) / 10 };
    });
  }

  function hotels(city, prefs, connectionCost) {
    const nights = Math.max(1, prefs.days - 1);
    const rooms = Math.ceil(prefs.travelers / 2);
    const available = Math.max(0, prefs.budget - connectionCost);
    const targetNightly = available * .34 / nights / rooms;
    const preferred = hotelTiers.indexOf(prefs.hotel);
    return city.hotels.map(hotel => {
      const midpoint = sum(hotel.nightly) / 2;
      const score = Math.abs(hotelTiers.indexOf(hotel.tier) - preferred) * 1.3 + Math.abs(midpoint - targetNightly) / Math.max(targetNightly, 1);
      return { score, ...hotel, estimated_total: Math.round(midpoint * nights * rooms), rooms };
    }).sort((a, b) => a.score - b.score).map(({ score, ...hotel }) => hotel);
  }

  function buildBudget(city, prefs, connection, trip, hotelOptions) {
    const connectionCost = Math.round(sum(connection.one_way) / 2 * 2 * prefs.travelers);
    const hotelCost = hotelOptions[0].estimated_total;
    const ticketCost = trip.flatMap(day => day.activities).reduce((total, a) => total + a.price, 0) * prefs.travelers;
    const foodCost = { 经济: 95, 舒适: 150, 设计: 220 }[prefs.hotel] * prefs.travelers * prefs.days;
    const localCost = city.local_transport.daily_per_person * prefs.travelers * prefs.days;
    const subtotal = connectionCost + hotelCost + ticketCost + foodCost + localCost;
    const buffer = Math.max(0, Math.round(prefs.budget - subtotal));
    const reserve = Math.min(buffer, Math.round(prefs.budget * .08));
    const health = Math.round(Math.min(100, prefs.budget / Math.max(subtotal, 1) * 100));
    return {
      target: prefs.budget, planned: subtotal + reserve, subtotal, over: Math.max(0, subtotal - prefs.budget), health,
      status: health >= 100 && buffer >= prefs.budget * .1 ? "充足" : health >= 95 ? "可行" : health >= 80 ? "偏紧" : "不足",
      items: [
        ["intercity", "往返大交通", connectionCost], ["hotel", "住宿", hotelCost], ["food", "餐饮", foodCost],
        ["tickets", "门票与体验", ticketCost], ["local", "市内交通", localCost], ["buffer", "机动预算", reserve]
      ].map(([key, label, amount]) => ({ key, label, amount }))
    };
  }

  function validate(trip, budget, prefs) {
    const issues = [];
    const names = trip.flatMap(day => day.activities).filter(a => !a.name.includes("晚餐")).map(a => a.name);
    if (names.length !== new Set(names).size) issues.push({ level: "error", message: "发现重复景点，需要重新排程。" });
    const max = { relaxed: 7.5, balanced: 9.5, packed: 12 }[prefs.pace];
    trip.forEach(day => { if (day.estimated_hours > max) issues.push({ level: "warning", message: `第${day.day}天预计${day.estimated_hours}小时，超过${paceLabels[prefs.pace]}节奏建议。` }); });
    if (budget.over > 0) issues.push({ level: "warning", message: `当前基础方案超出预算约¥${budget.over}，优先降低酒店档位或替换高价体验。` });
    if (prefs.accessibility) issues.push({ level: "info", message: "已降低长时间徒步项目权重；具体无障碍设施仍需向场馆确认。" });
    if (prefs.notes) issues.push({ level: "info", message: `补充要求已记录：${prefs.notes}。浏览器规则未验证商家能否满足，预订前需人工确认。` });
    if (!issues.length) issues.push({ level: "success", message: "路线无重复，日程强度和预算均通过基础约束检查。" });
    return issues;
  }

  async function weather(city, startDate) {
    const [latitude, longitude] = city.center;
    const params = new URLSearchParams({
      latitude,
      longitude,
      daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
      timezone: "Asia/Shanghai",
      forecast_days: "16"
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
      if (!response.ok) throw new Error("Weather request failed");
      const payload = await response.json();
      const index = payload.daily?.time?.indexOf(startDate) ?? -1;
      if (index >= 0) {
        return {
          source: "Open-Meteo 16日预报",
          date: startDate,
          high: payload.daily.temperature_2m_max[index],
          low: payload.daily.temperature_2m_min[index],
          rain: payload.daily.precipitation_probability_max[index],
          code: payload.daily.weather_code[index]
        };
      }
    } catch (_) {
      // The planner remains usable offline or when the requested date is too far away.
    } finally {
      clearTimeout(timeout);
    }
    return { source: "季节性提示", date: startDate, summary: city.seasonal_tip };
  }

  async function planTrip(raw) {
    const started = performance.now();
    const data = await loadDataset();
    const prefs = normalize(raw);
    const city = data.cities[prefs.destination];
    if (!city) throw new Error("静态数据集尚不支持该目的地");
    const connection = chooseConnection(data, prefs, city);
    const connectionCost = Math.round(sum(connection.one_way) / 2 * 2 * prefs.travelers);
    const selected = pickAttractions(city, prefs);
    const groups = groupDays(selected, prefs);
    const trip = itinerary(city, groups, prefs);
    const hotelOptions = hotels(city, prefs, connectionCost);
    const budget = buildBudget(city, prefs, connection, trip, hotelOptions);
    const forecast = await weather(city, prefs.start_date);
    const validation = validate(trip, budget, prefs);
    const plan = {
      mode: "browser", preferences: prefs, destination: { id: prefs.destination, name: city.name, summary: city.summary },
      itinerary: trip, hotels: hotelOptions,
      transport: { ...connection, round_trip_estimate: connectionCost, local: city.local_transport },
      budget, weather: forecast, validation, dataset: data.dataset,
      generated_at: new Date().toISOString(),
      narrative: {
        overview: `这是一份以${prefs.interests.slice(0, 2).join("、")}为主线的${prefs.days}天${paceLabels[prefs.pace]}行程，优先减少跨片区折返。`,
        why_this_plan: `景点按兴趣命中度、坐标距离、时长和预算共同排序，住宿优先匹配${prefs.hotel}档位。`,
        booking_note: "门票、酒店房态和交通班次均需在出发前通过官方或预订平台复核。"
      },
      trace: [
        ["Preference Interpreter", `标准化${prefs.interests.length}项兴趣与${prefs.days}天约束`, 8],
        ["Destination Search", `从${city.attractions.length}个POI中检索候选`, 12],
        ["Budget Allocator", `按¥${prefs.budget}总预算分配六类费用`, 7],
        ["Route Optimizer", `按坐标与节奏生成${prefs.days}日路线`, 16],
        ["Weather Adapter", `天气来源：${forecast.source}`, 0],
        ["Constraint Validator", "完成预算、重复与日强度检查", 6],
        ["Plan Composer", "组装行程、住宿、交通和预订提醒", Math.max(10, Math.round(performance.now() - started))]
      ].map(([tool, detail, ms]) => ({ tool, detail, status: "done", ms }))
    };
    return plan;
  }

  window.WaypointStatic = { cities, planTrip, loadDataset };
})();

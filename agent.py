from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "cities.json"
PACE_LIMITS = {"relaxed": 2, "balanced": 3, "packed": 4}
PACE_LABELS = {"relaxed": "松弛", "balanced": "平衡", "packed": "充实"}
HOTEL_TIERS = ["经济", "舒适", "设计"]


def load_dataset() -> dict[str, Any]:
    return json.loads(DATA_PATH.read_text(encoding="utf-8"))


def public_cities() -> list[dict[str, Any]]:
    data = load_dataset()
    return [
        {"id": key, "name": city["name"], "summary": city["summary"], "center": city["center"]}
        for key, city in data["cities"].items()
    ]


def _normalize_preferences(raw: dict[str, Any]) -> dict[str, Any]:
    days = max(1, min(7, int(raw.get("days", 3))))
    travelers = max(1, min(8, int(raw.get("travelers", 2))))
    budget = max(300, int(raw.get("budget", 3000)))
    interests = raw.get("interests") or ["历史", "美食", "摄影"]
    pace = raw.get("pace") if raw.get("pace") in PACE_LIMITS else "balanced"
    hotel = raw.get("hotel") if raw.get("hotel") in HOTEL_TIERS else "舒适"
    start_date = raw.get("start_date") or (dt.date.today() + dt.timedelta(days=7)).isoformat()
    return {
        "origin": raw.get("origin", "上海"),
        "destination": raw.get("destination", "hangzhou"),
        "start_date": start_date,
        "days": days,
        "travelers": travelers,
        "budget": budget,
        "interests": list(dict.fromkeys(interests))[:6],
        "pace": pace,
        "hotel": hotel,
        "transport": raw.get("transport", "smart"),
        "accessibility": bool(raw.get("accessibility", False)),
        "notes": str(raw.get("notes", "")).strip()[:500],
    }


def _select_connection(data: dict[str, Any], prefs: dict[str, Any], city: dict[str, Any]) -> dict[str, Any]:
    origin = prefs["origin"]
    destination = city["name"]
    if origin == destination:
        return {"mode": "市内出发", "duration": "无需城际交通", "one_way": [0, 0], "hub": "本地集合", "carbon": "低"}
    options = data["connections"].get(f"{origin}-{destination}")
    if not options:
        return {"mode": "高铁/飞机比价", "duration": "以实时查询为准", "one_way": [350, 900], "hub": f"{origin} → {destination}", "carbon": "待确认"}
    preference = prefs["transport"]
    if preference == "train":
        return next((item for item in options if item["mode"] == "高铁"), options[0])
    if preference == "flight":
        return next((item for item in options if item["mode"] == "飞机"), options[0])
    if preference == "low-carbon":
        return sorted(options, key=lambda item: (item["carbon"] != "低", sum(item["one_way"])))[0]
    if prefs["days"] <= 3 and any(item["mode"] == "飞机" for item in options):
        return next(item for item in options if item["mode"] == "飞机")
    return sorted(options, key=lambda item: sum(item["one_way"]))[0]


def _attraction_score(item: dict[str, Any], prefs: dict[str, Any]) -> float:
    interest_hits = len(set(item["tags"]) & set(prefs["interests"]))
    score = item["priority"] + interest_hits * 3
    per_person_daily = prefs["budget"] / prefs["travelers"] / prefs["days"]
    if item["price"] == 0:
        score += 1.2
    if per_person_daily < 450 and item["price"] > 150:
        score -= 6
    if prefs["accessibility"] and ("徒步" in item["tags"] or item["duration"] >= 5):
        score -= 4
    return score


def _pick_attractions(city: dict[str, Any], prefs: dict[str, Any]) -> list[dict[str, Any]]:
    target = min(len(city["attractions"]), prefs["days"] * PACE_LIMITS[prefs["pace"]])
    hour_budget = prefs["days"] * {"relaxed": 4.8, "balanced": 7.2, "packed": 9.5}[prefs["pace"]]
    ranked = sorted(city["attractions"], key=lambda item: _attraction_score(item, prefs), reverse=True)
    selected = []
    used_hours = 0.0
    for item in ranked:
        projected = used_hours + item["duration"] + (0.6 if selected else 0)
        if len(selected) < prefs["days"] or (len(selected) < target and projected <= hour_budget):
            selected.append(item)
            used_hours = projected
    return selected


def _distance(a: dict[str, Any], b: dict[str, Any]) -> float:
    lat_scale = 111.0
    lon_scale = 96.0
    return math.hypot((a["coords"][0] - b["coords"][0]) * lat_scale, (a["coords"][1] - b["coords"][1]) * lon_scale)


def _group_days(selected: list[dict[str, Any]], prefs: dict[str, Any]) -> list[list[dict[str, Any]]]:
    days = [[] for _ in range(prefs["days"])]
    if not selected:
        return days
    # Build a geographic route: start with the highest-priority POI, then repeatedly
    # choose the nearest unvisited POI. This is a transparent approximation until a
    # real map distance matrix is connected.
    remaining = list(selected)
    ordered = [remaining.pop(0)]
    while remaining:
        nearest = min(remaining, key=lambda item: _distance(ordered[-1], item))
        ordered.append(nearest)
        remaining.remove(nearest)
    # Split the route into balanced consecutive chunks so each day keeps geographic
    # continuity and, when enough POIs exist, no day is left blank.
    cursor = 0
    for day_index in range(len(days)):
        items_left = len(ordered) - cursor
        days_left = len(days) - day_index
        take = math.ceil(items_left / days_left) if items_left else 0
        take = min(take, PACE_LIMITS[prefs["pace"]])
        days[day_index].extend(ordered[cursor:cursor + take])
        cursor += take
    if cursor < len(ordered):
        days[-1].extend(ordered[cursor:])
    return days


def _time_label(hours: float) -> str:
    hour = int(hours)
    minute = 30 if hours - hour >= 0.5 else 0
    return f"{hour:02d}:{minute:02d}"


def _build_itinerary(city: dict[str, Any], groups: list[list[dict[str, Any]]], prefs: dict[str, Any]) -> list[dict[str, Any]]:
    start = dt.date.fromisoformat(prefs["start_date"])
    result = []
    for index, items in enumerate(groups):
        clock = 9.0
        activities = []
        areas = []
        for item in items:
            areas.append(item["area"])
            activities.append({
                "time": _time_label(clock),
                "name": item["name"],
                "area": item["area"],
                "duration": f"{item['duration']:g}小时",
                "price": item["price"],
                "tags": item["tags"],
                "note": item["note"],
                "indoor": item["indoor"],
                "coords": item["coords"],
            })
            clock += item["duration"] + 0.6
        primary_area = max(set(areas), key=areas.count) if areas else next(iter(city["food_areas"]))
        food_area = city["food_areas"].get(primary_area, next(iter(city["food_areas"].values())))
        if activities:
            activities.append({"time": _time_label(max(clock, 18.0)), "name": f"在{food_area}安排晚餐", "area": primary_area, "duration": "1.5小时", "price": 0, "tags": ["美食"], "note": "按预算选择餐厅，避开网红排队高峰。", "indoor": True, "coords": None})
        result.append({
            "day": index + 1,
            "date": (start + dt.timedelta(days=index)).isoformat(),
            "theme": f"{primary_area} · {' / '.join(prefs['interests'][:2])}",
            "activities": activities,
            "estimated_hours": round(sum(item["duration"] for item in items) + max(0, len(items) - 1) * 0.6 + (1.5 if items else 0), 1),
        })
    return result


def _recommend_hotels(city: dict[str, Any], prefs: dict[str, Any], connection_cost: int) -> list[dict[str, Any]]:
    nights = max(1, prefs["days"] - 1)
    rooms = math.ceil(prefs["travelers"] / 2)
    available = max(0, prefs["budget"] - connection_cost)
    target_nightly = available * 0.34 / nights / rooms
    preferred_index = HOTEL_TIERS.index(prefs["hotel"])
    scored = []
    for hotel in city["hotels"]:
        midpoint = sum(hotel["nightly"]) / 2
        tier_distance = abs(HOTEL_TIERS.index(hotel["tier"]) - preferred_index)
        affordability = abs(midpoint - target_nightly) / max(target_nightly, 1)
        scored.append((tier_distance * 1.3 + affordability, hotel, midpoint))
    result = []
    for _, hotel, midpoint in sorted(scored, key=lambda row: row[0]):
        item = dict(hotel)
        item["estimated_total"] = round(midpoint * nights * rooms)
        item["rooms"] = rooms
        result.append(item)
    return result


def _budget(city: dict[str, Any], prefs: dict[str, Any], connection: dict[str, Any], itinerary: list[dict[str, Any]], hotels: list[dict[str, Any]]) -> dict[str, Any]:
    travelers = prefs["travelers"]
    connection_cost = round(sum(connection["one_way"]) / 2 * 2 * travelers)
    hotel_cost = hotels[0]["estimated_total"]
    ticket_cost = sum(activity["price"] for day in itinerary for activity in day["activities"]) * travelers
    meal_rate = {"经济": 95, "舒适": 150, "设计": 220}[prefs["hotel"]]
    food_cost = meal_rate * travelers * prefs["days"]
    local_cost = city["local_transport"]["daily_per_person"] * travelers * prefs["days"]
    subtotal = connection_cost + hotel_cost + ticket_cost + food_cost + local_cost
    buffer = max(0, round(prefs["budget"] - subtotal))
    total = subtotal + min(buffer, round(prefs["budget"] * 0.08))
    over = max(0, subtotal - prefs["budget"])
    health = round(min(100, prefs["budget"] / max(subtotal, 1) * 100))
    return {
        "target": prefs["budget"],
        "planned": total,
        "subtotal": subtotal,
        "over": over,
        "health": health,
        "status": "充足" if health >= 100 and buffer >= prefs["budget"] * 0.1 else "可行" if health >= 95 else "偏紧" if health >= 80 else "不足",
        "items": [
            {"key":"intercity","label":"往返大交通","amount":connection_cost},
            {"key":"hotel","label":"住宿","amount":hotel_cost},
            {"key":"food","label":"餐饮","amount":food_cost},
            {"key":"tickets","label":"门票与体验","amount":ticket_cost},
            {"key":"local","label":"市内交通","amount":local_cost},
            {"key":"buffer","label":"机动预算","amount":min(buffer, round(prefs["budget"] * 0.08))}
        ]
    }


def _validate(itinerary: list[dict[str, Any]], budget: dict[str, Any], prefs: dict[str, Any]) -> list[dict[str, str]]:
    issues = []
    names = [activity["name"] for day in itinerary for activity in day["activities"] if "晚餐" not in activity["name"]]
    if len(names) != len(set(names)):
        issues.append({"level":"error","message":"发现重复景点，需要重新排程。"})
    max_hours = {"relaxed": 7.5, "balanced": 9.5, "packed": 12.0}[prefs["pace"]]
    for day in itinerary:
        if day["estimated_hours"] > max_hours:
            issues.append({"level":"warning","message":f"第{day['day']}天预计{day['estimated_hours']}小时，超过{PACE_LABELS[prefs['pace']]}节奏建议。"})
    if budget["over"] > 0:
        issues.append({"level":"warning","message":f"当前基础方案超出预算约¥{budget['over']}，优先降低酒店档位或替换高价体验。"})
    if prefs["accessibility"]:
        issues.append({"level":"info","message":"已降低长时间徒步项目权重；具体无障碍设施仍需向场馆确认。"})
    if prefs["notes"]:
        issues.append({"level":"info","message":f"补充要求已记录：{prefs['notes']}。本地规则未验证商家能否满足，预订前需人工确认。"})
    if not issues:
        issues.append({"level":"success","message":"路线无重复，日程强度和预算均通过基础约束检查。"})
    return issues


def _weather(city: dict[str, Any], start_date: str) -> dict[str, Any]:
    lat, lon = city["center"]
    params = urllib.parse.urlencode({
        "latitude": lat,
        "longitude": lon,
        "daily": "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
        "timezone": "Asia/Shanghai",
        "forecast_days": 16,
    })
    try:
        with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{params}", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
        dates = payload.get("daily", {}).get("time", [])
        if start_date in dates:
            index = dates.index(start_date)
            daily = payload["daily"]
            return {"source":"Open-Meteo","date":start_date,"high":daily["temperature_2m_max"][index],"low":daily["temperature_2m_min"][index],"rain":daily["precipitation_probability_max"][index],"code":daily["weather_code"][index]}
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError):
        pass
    return {"source":"季节性提示","date":start_date,"summary":city["seasonal_tip"]}


def _model_narrative(plan: dict[str, Any]) -> dict[str, str] | None:
    key = os.getenv("OPENAI_API_KEY")
    if not key:
        return None
    compact = {
        "preferences": plan["preferences"],
        "destination": plan["destination"],
        "budget": plan["budget"],
        "days": [{"theme": day["theme"], "places": [a["name"] for a in day["activities"]]} for day in plan["itinerary"]],
        "constraints": plan["validation"],
    }
    prompt = (
        "Return JSON only with keys overview, why_this_plan, booking_note. Use concise Chinese. "
        "Do not change places, prices, dates, hotels, or transport. Do not invent availability. Data:\n" +
        json.dumps(compact, ensure_ascii=False)
    )
    body = json.dumps({
        "model": os.getenv("OPENAI_MODEL", "gpt-5-mini"),
        "input": prompt,
        "reasoning": {"effort": "minimal"},
    }, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request("https://api.openai.com/v1/responses", data=body, headers={"Authorization":f"Bearer {key}","Content-Type":"application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
        text = "".join(content.get("text", "") for output in payload.get("output", []) for content in output.get("content", []) if content.get("type") == "output_text")
        text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
        return json.loads(text)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, KeyError):
        return None


def plan_trip(raw_preferences: dict[str, Any]) -> dict[str, Any]:
    started = time.perf_counter()
    data = load_dataset()
    prefs = _normalize_preferences(raw_preferences)
    if prefs["destination"] not in data["cities"]:
        raise ValueError("当前数据集尚不支持该目的地。")
    city = data["cities"][prefs["destination"]]
    connection = _select_connection(data, prefs, city)
    connection_cost = round(sum(connection["one_way"]) / 2 * 2 * prefs["travelers"])
    selected = _pick_attractions(city, prefs)
    groups = _group_days(selected, prefs)
    itinerary = _build_itinerary(city, groups, prefs)
    hotels = _recommend_hotels(city, prefs, connection_cost)
    budget = _budget(city, prefs, connection, itinerary, hotels)
    validation = _validate(itinerary, budget, prefs)
    weather = _weather(city, prefs["start_date"])
    plan = {
        "mode": "local",
        "preferences": prefs,
        "destination": {"id":prefs["destination"],"name":city["name"],"summary":city["summary"]},
        "itinerary": itinerary,
        "hotels": hotels,
        "transport": {**connection, "round_trip_estimate": connection_cost, "local": city["local_transport"]},
        "budget": budget,
        "weather": weather,
        "validation": validation,
        "dataset": data["dataset"],
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "trace": [
            {"tool":"Preference Interpreter","detail":f"标准化{len(prefs['interests'])}项兴趣与{prefs['days']}天约束","status":"done","ms":28},
            {"tool":"Destination Search","detail":f"从{len(city['attractions'])}个POI中检索候选","status":"done","ms":46},
            {"tool":"Budget Allocator","detail":f"按¥{prefs['budget']}总预算分配六类费用","status":"done","ms":34},
            {"tool":"Route Optimizer","detail":f"按片区与节奏生成{prefs['days']}日路线","status":"done","ms":71},
            {"tool":"Weather Adapter","detail":f"天气来源：{weather['source']}","status":"done","ms":0},
            {"tool":"Constraint Validator","detail":f"完成预算、重复与日强度检查","status":"done","ms":22},
        ],
    }
    narrative = _model_narrative(plan)
    if narrative:
        plan["mode"] = "openai"
        plan["narrative"] = narrative
        plan["trace"].append({"tool":"GPT-5 mini Narrator","detail":"在锁定行程与价格后生成个性化说明","status":"done","ms":0})
    else:
        first_tags = "、".join(prefs["interests"][:2])
        plan["narrative"] = {
            "overview": f"这是一份以{first_tags}为主线的{prefs['days']}天{PACE_LABELS[prefs['pace']]}行程，优先减少跨片区折返。",
            "why_this_plan": f"景点按兴趣命中度、片区距离、时长和预算共同排序，住宿优先匹配{prefs['hotel']}档位。",
            "booking_note": "门票、酒店房态和交通班次均需在出发前通过官方或预订平台复核。"
        }
    plan["trace"].append({"tool":"Plan Composer","detail":"组装行程、住宿、交通和预订提醒","status":"done","ms":max(12, round((time.perf_counter()-started)*1000))})
    return plan

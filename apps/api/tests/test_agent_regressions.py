import pytest


@pytest.mark.asyncio
async def test_weight_lookup_uses_account_scope(monkeypatch):
    from api.agent import Input, Session, run
    import api.agent as agent

    calls = {"weight": []}

    async def fake_weight_call_json(tool_suffix: str, args: dict):
        calls["weight"].append((tool_suffix, args))
        assert tool_suffix == "weight_profile_get"
        assert args.get("scope") == {"accountAddress": "acct:test_user"}
        return {
            "ok": True,
            "profile": {
                "weight_lb": 227,
                "weight_at_ms": 1775408400000,
            },
        }

    async def fake_core_call_json(tool_suffix: str, args: dict):
        return {}

    async def fake_memory_append(thread_id: str, role: str, content: str):
        return None

    async def no_import(session, bundle):
        return bundle, []

    monkeypatch.setattr(agent, "_weight_call_json", fake_weight_call_json)
    monkeypatch.setattr(agent, "_core_call_json", fake_core_call_json)
    monkeypatch.setattr(agent, "_memory_append", fake_memory_append)
    monkeypatch.setattr(agent, "_auto_import_telegram_meal_texts", no_import)
    monkeypatch.setattr(agent, "_auto_import_telegram_weight_texts", no_import)

    out = await run(
        Input(
            message="what is my weight",
            session=Session(
                timezone="America/Denver",
                accountAddress="acct:test_user",
            ),
        )
    )
    assert "227 lb" in out.answer
    assert calls["weight"], "expected weight_profile_get to be called"


@pytest.mark.asyncio
async def test_weight_log_uses_weight_mcp_and_account_scope(monkeypatch):
    from api.agent import Input, Session, run
    import api.agent as agent

    calls = {"weight": []}

    async def fake_weight_call_json(tool_suffix: str, args: dict):
        calls["weight"].append((tool_suffix, args))
        assert tool_suffix == "weight_log_weight"
        assert args.get("scope") == {"accountAddress": "acct:test_user"}
        assert args.get("weightLb") == 227
        assert args.get("source") == "chat"
        assert isinstance(args.get("atISO"), str) and args["atISO"]
        return {"ok": True, "weight_kg": 102.965462}

    async def fake_core_call_json(tool_suffix: str, args: dict):
        return {}

    async def fake_memory_append(thread_id: str, role: str, content: str):
        return None

    async def no_import(session, bundle):
        return bundle, []

    monkeypatch.setattr(agent, "_weight_call_json", fake_weight_call_json)
    monkeypatch.setattr(agent, "_core_call_json", fake_core_call_json)
    monkeypatch.setattr(agent, "_memory_append", fake_memory_append)
    monkeypatch.setattr(agent, "_auto_import_telegram_meal_texts", no_import)
    monkeypatch.setattr(agent, "_auto_import_telegram_weight_texts", no_import)

    out = await run(
        Input(
            message="I weigh 227 lb's now",
            session=Session(
                timezone="America/Denver",
                accountAddress="acct:test_user",
            ),
        )
    )
    assert "Logged your weight as 227 lb." in out.answer
    assert calls["weight"], "expected weight_log_weight to be called"


@pytest.mark.asyncio
async def test_weight_profile_upsert_logs_weight_when_present(monkeypatch):
    from api.agent import Input, Session, run
    import api.agent as agent

    calls = {"weight": []}

    async def fake_weight_call_json(tool_suffix: str, args: dict):
        calls["weight"].append((tool_suffix, args))
        if tool_suffix == "weight_profile_upsert":
            return {"ok": True, "updated_at": 123}
        if tool_suffix == "weight_log_weight":
            assert args.get("scope") == {"accountAddress": "acct:test_user"}
            assert args.get("weightLb") == 227
            assert args.get("source") == "profile_form"
            return {"ok": True, "updated_at": 124}
        raise AssertionError(f"unexpected tool suffix: {tool_suffix}")

    async def fake_core_call_json(tool_suffix: str, args: dict):
        return {}

    async def fake_memory_append(thread_id: str, role: str, content: str):
        return None

    async def no_import(session, bundle):
        return bundle, []

    monkeypatch.setattr(agent, "_weight_call_json", fake_weight_call_json)
    monkeypatch.setattr(agent, "_core_call_json", fake_core_call_json)
    monkeypatch.setattr(agent, "_memory_append", fake_memory_append)
    monkeypatch.setattr(agent, "_auto_import_telegram_meal_texts", no_import)
    monkeypatch.setattr(agent, "_auto_import_telegram_weight_texts", no_import)

    out = await run(
        Input(
            message='__WEIGHT_PROFILE_UPSERT__:{"profile":{"weight_lb":227,"age":42}}',
            session=Session(
                timezone="America/Denver",
                accountAddress="acct:test_user",
            ),
        )
    )
    assert out.data and out.data.get("ok") is True
    assert out.data.get("weightLogged") is True
    assert [name for name, _args in calls["weight"]] == ["weight_profile_upsert", "weight_log_weight"]


@pytest.mark.asyncio
async def test_food_past_week_summary(monkeypatch):
    from api.agent import Input, Session, run
    import api.agent as agent

    calls = {"weight": []}

    async def fake_weight_call_json(tool_suffix: str, args: dict):
        calls["weight"].append((tool_suffix, args))
        assert tool_suffix == "weight_list_food"
        # minimal shape from weight-management-mcp
        return {
            "ok": True,
            "items": [
                {
                    "id": "food1",
                    "at_ms": 1774102800000,  # 2026-03-20T??Z (just a stable ms)
                    "meal": "breakfast",
                    "text": "2 eggs + wheat toast",
                    "calories": 320,
                    "image_url": "https://example.com/meal.jpg",
                }
            ],
        }

    async def fake_core_call_json(tool_suffix: str, args: dict):
        return {}

    async def fake_memory_append(thread_id: str, role: str, content: str):
        return None

    async def no_import(session, bundle):
        return bundle, []

    monkeypatch.setattr(agent, "_weight_call_json", fake_weight_call_json)
    monkeypatch.setattr(agent, "_core_call_json", fake_core_call_json)
    monkeypatch.setattr(agent, "_memory_append", fake_memory_append)
    monkeypatch.setattr(agent, "_auto_import_telegram_meal_texts", no_import)
    monkeypatch.setattr(agent, "_auto_import_telegram_weight_texts", no_import)

    out = await run(
        Input(
            message="what have i eaten in past week",
            session=Session(
                timezone="America/Denver",
                telegramUserId="6105195555",
            ),
        )
    )
    assert "Meals for the past 7 days" in out.answer
    assert "2 eggs + wheat toast" in out.answer
    assert calls["weight"], "expected weight_list_food to be called"
    assert out.data and isinstance(out.data, dict)
    assert "foodItems" in out.data
    assert isinstance(out.data["foodItems"], list)
    assert out.data["foodItems"][0].get("image_url") == "https://example.com/meal.jpg"


@pytest.mark.asyncio
async def test_workouts_past_few_days_summary(monkeypatch):
    from api.agent import Input, Session, run
    import api.agent as agent

    calls = {"strava": []}

    async def fake_strava_call_json(tool_suffix: str, args: dict):
        calls["strava"].append((tool_suffix, args))
        assert tool_suffix == "strava_list_workouts"
        assert args.get("telegramUserId") == "6105195555"
        return {
            "workouts": [
                {
                    "workout_id": "strava-1",
                    "activity_type": "Run",
                    "started_at_iso": "2026-03-20T15:00:00Z",
                    "duration_seconds": 3120,
                    "distance_meters": 9656,
                }
            ]
        }

    async def fake_core_call_json(tool_suffix: str, args: dict):
        return {}

    async def fake_memory_append(thread_id: str, role: str, content: str):
        return None

    async def no_import(session, bundle):
        return bundle, []

    monkeypatch.setattr(agent, "_strava_call_json", fake_strava_call_json)
    monkeypatch.setattr(agent, "_core_call_json", fake_core_call_json)
    monkeypatch.setattr(agent, "_memory_append", fake_memory_append)
    monkeypatch.setattr(agent, "_auto_import_telegram_meal_texts", no_import)
    monkeypatch.setattr(agent, "_auto_import_telegram_weight_texts", no_import)

    out = await run(
        Input(
            message="show me my workouts over last week",
            session=Session(
                timezone="America/Denver",
                telegramUserId="6105195555",
            ),
        )
    )
    assert "Workouts" in out.answer
    assert "Run" in out.answer
    assert calls["strava"], "expected strava_list_workouts to be called"


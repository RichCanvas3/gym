import pytest


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
                waiver={"accountAddress": "acct_cust_casey"},
            ),
        )
    )
    assert "Meals for the past 7 days" in out.answer
    assert "2 eggs + wheat toast" in out.answer
    assert calls["weight"], "expected weight_list_food to be called"


@pytest.mark.asyncio
async def test_workouts_past_few_days_summary(monkeypatch):
    from api.agent import Input, Session, run
    import api.agent as agent

    calls = {"strava": []}

    async def fake_strava_call_json(tool_suffix: str, args: dict):
        calls["strava"].append((tool_suffix, args))
        assert tool_suffix == "strava_list_workouts"
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
            message="what exercises have i done in past few days",
            session=Session(
                timezone="America/Denver",
                waiver={"accountAddress": "acct_cust_casey"},
            ),
        )
    )
    assert "Workouts" in out.answer
    assert "Run" in out.answer
    assert calls["strava"], "expected strava_list_workouts to be called"


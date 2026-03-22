import os

import pytest
import httpx


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


@pytest.mark.live
@pytest.mark.asyncio
async def test_langgraph_runs_wait_live():
    url = _env("LANGGRAPH_DEPLOYMENT_URL")
    key = _env("LANGSMITH_API_KEY")
    assistant_id = _env("LANGGRAPH_ASSISTANT_ID") or "gym"
    if not url or not key:
        pytest.skip("missing LANGGRAPH_DEPLOYMENT_URL or LANGSMITH_API_KEY")

    async with httpx.AsyncClient(timeout=60.0) as c:
        res = await c.post(
            f"{url.rstrip('/')}/runs/wait",
            headers={"x-api-key": key},
            json={
                "assistant_id": assistant_id,
                "input": {
                    "message": "show me my workouts over last week",
                    "session": {"timezone": "America/Denver", "waiver": {"accountAddress": "acct_cust_casey"}},
                },
            },
        )
        assert res.status_code == 200
        j = res.json()
        assert isinstance(j, dict), f"unexpected response: {j!r}"
        if "__error__" in j:
            raise AssertionError(f"LangGraph returned __error__: {j['__error__']!r}")
        out = (j.get("output") or {}) if isinstance(j, dict) else {}
        answer = out.get("answer") if isinstance(out, dict) else None
        assert isinstance(answer, str)
        assert answer.strip()


@pytest.mark.live
@pytest.mark.asyncio
async def test_langgraph_today_calorie_overview_live():
    url = _env("LANGGRAPH_DEPLOYMENT_URL")
    key = _env("LANGSMITH_API_KEY")
    assistant_id = _env("LANGGRAPH_ASSISTANT_ID") or "gym"
    if not url or not key:
        pytest.skip("missing LANGGRAPH_DEPLOYMENT_URL or LANGSMITH_API_KEY")

    async with httpx.AsyncClient(timeout=60.0) as c:
        res = await c.post(
            f"{url.rstrip('/')}/runs/wait",
            headers={"x-api-key": key},
            json={
                "assistant_id": assistant_id,
                "input": {
                    "message": "what about my exercise/workouts and day calorie burn overview today",
                    "session": {"timezone": "America/Denver", "waiver": {"accountAddress": "acct_cust_casey"}},
                },
            },
        )
        assert res.status_code == 200
        j = res.json()
        assert isinstance(j, dict), f"unexpected response: {j!r}"
        if "__error__" in j:
            raise AssertionError(f"LangGraph returned __error__: {j['__error__']!r}")
        out = (j.get("output") or {}) if isinstance(j, dict) else {}
        answer = out.get("answer") if isinstance(out, dict) else None
        assert isinstance(answer, str)
        # Assert we produce a joined overview, not a partial.
        assert "Calories in" in answer or "Intake" in answer
        assert "Calories out" in answer or "Exercise burn" in answer
        assert "Net" in answer


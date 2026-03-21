import os

import pytest
import httpx


def _env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


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
                    "message": "what exercises have i done in past few days",
                    "session": {"timezone": "America/Denver", "waiver": {"accountAddress": "acct_cust_casey"}},
                },
            },
        )
        assert res.status_code == 200
        j = res.json()
        out = (j.get("output") or {}) if isinstance(j, dict) else {}
        answer = out.get("answer") if isinstance(out, dict) else None
        assert isinstance(answer, str)
        assert answer.strip()


from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from langserve import add_routes
from langchain_core.runnables import RunnableLambda

from .agent import Input, Output, run


app = FastAPI(title="Erie Rec Center Fitness API", version="0.1.0")

allow_origins = os.environ.get("CORS_ALLOW_ORIGINS", "*")
origins = ["*"] if allow_origins.strip() == "*" else [o.strip() for o in allow_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _invoke(x: dict) -> dict:
    out = await run(Input(**x))
    return out.model_dump()


gym_runnable = RunnableLambda(_invoke)

add_routes(
    app,
    gym_runnable,
    path="/gym",
    input_type=dict,
    output_type=dict,
)


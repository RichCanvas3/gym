from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(frozen=True)
class CatalogItem:
    sku: str
    name: str
    category: str
    priceCents: int
    currency: str = "USD"
    description: str | None = None
    requiresFacilityAccess: bool | None = None
    includes: list[str] | None = None


# --- seed ops data (python mirror of packages/ops) ---

CLASSES: list[dict[str, Any]] = [
    {
        "id": "class_boulder_fundamentals_001",
        "title": "Bouldering Fundamentals",
        "type": "group",
        "skillLevel": "beginner",
        "coachId": "coach_maya",
        "startTimeISO": "2026-03-02T18:00:00-07:00",
        "durationMinutes": 75,
        "capacity": 10,
    },
    {
        "id": "class_top_rope_basics_001",
        "title": "Top Rope Basics",
        "type": "group",
        "skillLevel": "beginner",
        "coachId": "coach_jordan",
        "startTimeISO": "2026-03-03T18:30:00-07:00",
        "durationMinutes": 90,
        "capacity": 8,
    },
    {
        "id": "class_lead_belay_001",
        "title": "Lead Climbing + Belay",
        "type": "group",
        "skillLevel": "intermediate",
        "coachId": "coach_jordan",
        "startTimeISO": "2026-03-05T19:00:00-07:00",
        "durationMinutes": 120,
        "capacity": 6,
    },
    {
        "id": "class_private_coaching_001",
        "title": "Private Coaching (1:1)",
        "type": "private",
        "skillLevel": "beginner",
        "coachId": "coach_maya",
        "startTimeISO": "2026-03-04T17:00:00-07:00",
        "durationMinutes": 60,
        "capacity": 1,
    },
    {
        "id": "class_outdoor_wall_intro_001",
        "title": "Outdoor Wall Intro + Safety",
        "type": "group",
        "skillLevel": "beginner",
        "coachId": "coach_sam",
        "startTimeISO": "2026-03-06T16:30:00-07:00",
        "durationMinutes": 60,
        "capacity": 10,
    },
    {
        "id": "class_outdoor_lead_clinic_001",
        "title": "Outdoor Lead Skills Clinic",
        "type": "group",
        "skillLevel": "intermediate",
        "coachId": "coach_jordan",
        "startTimeISO": "2026-03-07T10:00:00-07:00",
        "durationMinutes": 120,
        "capacity": 6,
    },
]

CLASS_ENROLLMENTS: dict[str, int] = {
    "class_boulder_fundamentals_001": 7,
    "class_top_rope_basics_001": 8,
    "class_lead_belay_001": 3,
    "class_private_coaching_001": 1,
    "class_outdoor_wall_intro_001": 5,
    "class_outdoor_lead_clinic_001": 2,
}


PRODUCT_AVAILABILITY: list[dict[str, Any]] = [
    {"sku": "RENTAL_SHOE", "size": "10", "inStock": True, "quantity": 4},
    {"sku": "RENTAL_SHOE", "size": "11", "inStock": True, "quantity": 2},
    {"sku": "RENTAL_SHOE", "size": "12", "inStock": False, "quantity": 0},
    {"sku": "RENTAL_HARNESS", "inStock": True, "quantity": 7},
    {"sku": "CHALK_200G", "inStock": True, "quantity": 18},
    {"sku": "DAY_PASS", "inStock": True, "quantity": 9999},
    {"sku": "ACCESS_5PACK", "inStock": True, "quantity": 9999},
    {"sku": "MEMBERSHIP_ALL_ACCESS_MONTHLY", "inStock": True, "quantity": 9999},
    {"sku": "COACHING_PRIVATE_60", "inStock": True, "quantity": 9999},
    {"sku": "CAMP_SPRING_BREAK_2026", "inStock": True, "quantity": 12},
]


CAMPS: list[dict[str, Any]] = [
    {
        "id": "camp_spring_break_2026",
        "sku": "CAMP_SPRING_BREAK_2026",
        "title": "Spring Break Climbing Camp",
        "startDateISO": "2026-03-23",
        "endDateISO": "2026-03-27",
        "dailyStartTimeLocal": "09:00",
        "dailyDurationMinutes": 360,
        "includesLunch": True,
        "parentsPresent": False,
        "capacity": 18,
    }
]

CAMP_ENROLLMENTS: dict[str, int] = {"camp_spring_break_2026": 9}


BASE_CATALOG: list[CatalogItem] = [
    CatalogItem(
        sku="DAY_PASS",
        name="Day Pass",
        category="day_pass",
        description="Single-day facility access.",
        priceCents=2500,
        includes=["facility_access"],
    ),
    CatalogItem(
        sku="ACCESS_5PACK",
        name="5-Pack Day Passes",
        category="pack",
        description="Five visits at a discount.",
        priceCents=11000,
        includes=["facility_access_x5"],
    ),
    CatalogItem(
        sku="MEMBERSHIP_ALL_ACCESS_MONTHLY",
        name="All-Access Monthly Membership",
        category="membership",
        description="Facility access + lockers + usage of shared equipment.",
        priceCents=8900,
        includes=["facility_access", "lockers", "shared_equipment_use"],
    ),
    CatalogItem(
        sku="COACHING_PRIVATE_60",
        name="Private Coaching (60 minutes)",
        category="service",
        description="One-hour 1:1 coaching session. Requires separate facility access.",
        priceCents=9000,
        requiresFacilityAccess=True,
        includes=["coaching_60min"],
    ),
    CatalogItem(
        sku="RENTAL_SHOE",
        name="Rental Climbing Shoes",
        category="rental",
        description="Rental shoes (size-based availability).",
        priceCents=600,
        requiresFacilityAccess=True,
    ),
    CatalogItem(
        sku="RENTAL_HARNESS",
        name="Rental Harness",
        category="rental",
        description="Rental harness.",
        priceCents=500,
        requiresFacilityAccess=True,
    ),
    CatalogItem(
        sku="CHALK_200G",
        name="Loose Chalk (200g)",
        category="chalk",
        description="Retail chalk bag.",
        priceCents=1499,
    ),
    CatalogItem(
        sku="TAPE_ATHLETIC",
        name="Athletic Tape",
        category="accessory",
        description="Basic athletic tape for finger care.",
        priceCents=599,
    ),
    CatalogItem(
        sku="CAMP_SPRING_BREAK_2026",
        name="Spring Break Climbing Camp (Mar 23–27)",
        category="camp",
        description="Daily instruction + lunch. Parents not present. Weather may affect outdoor components.",
        priceCents=42500,
        includes=["camp_instruction", "lunch"],
    ),
]


def make_class_registration_sku(class_id: str) -> str:
    return f"CLASSREG_{class_id}"


def class_to_catalog_item(c: dict[str, Any]) -> CatalogItem:
    price_cents = 9000 if c.get("type") == "private" else 3500
    return CatalogItem(
        sku=make_class_registration_sku(str(c["id"])),
        name=f"Class Registration: {c['title']}",
        category="class",
        description=f"Register 1 person for {c['title']}. Starts {c['startTimeISO']}.",
        priceCents=price_cents,
        requiresFacilityAccess=True,
        includes=["class_registration", str(c["id"])],
    )


def full_catalog() -> list[CatalogItem]:
    return [*BASE_CATALOG, *[class_to_catalog_item(c) for c in CLASSES]]


def catalog_item_by_sku(sku: str) -> Optional[CatalogItem]:
    for item in full_catalog():
        if item.sku == sku:
            return item
    return None


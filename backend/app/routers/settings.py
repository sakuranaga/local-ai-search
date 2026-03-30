from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.deps import get_current_user, require_permission
from app.models import SystemSetting, User
from app.services.audit import audit_log
from app.services.settings import DEFAULTS

router = APIRouter(prefix="/settings", tags=["settings"])


class SettingItem(BaseModel):
    key: str
    value: str
    description: str | None = None
    placeholder: str | None = None
    secret: bool = False


class SettingUpdate(BaseModel):
    value: str


# Public settings readable by any authenticated user
PUBLIC_KEYS: set[str] = {"share_enabled"}


@router.get("/public/{key}")
async def get_public_setting(
    key: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get a single public setting (available to all authenticated users)."""
    if key not in PUBLIC_KEYS:
        raise HTTPException(status_code=404, detail="Setting not found")
    from app.services.settings import get_setting
    value = await get_setting(db, key)
    return {"key": key, "value": value}


@router.get("", response_model=list[SettingItem])
async def list_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    result = await db.execute(select(SystemSetting))
    db_settings = {row.key: row for row in result.scalars().all()}

    items = []
    for key, default in DEFAULTS.items():
        is_secret = default.get("secret", False)
        raw_value = db_settings[key].value if key in db_settings else default["value"]
        if is_secret and raw_value:
            display_value = "••••••••" + raw_value[-4:]
        else:
            display_value = raw_value
        items.append(SettingItem(
            key=key,
            value=display_value,
            description=default["description"],
            placeholder=default.get("placeholder"),
            secret=is_secret,
        ))
    return items


@router.put("/{key}", response_model=SettingItem)
async def update_setting(
    key: str,
    body: SettingUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_permission("admin")),
):
    if key not in DEFAULTS:
        raise HTTPException(status_code=400, detail=f"Unknown setting: {key}")

    result = await db.execute(
        select(SystemSetting).where(SystemSetting.key == key)
    )
    row = result.scalar_one_or_none()

    if row:
        row.value = body.value
    else:
        row = SystemSetting(
            key=key,
            value=body.value,
            description=DEFAULTS[key]["description"],
        )
        db.add(row)

    await db.flush()

    is_secret = DEFAULTS[key].get("secret", False)
    await audit_log(db, user=current_user, action="setting.update", target_type="setting",
                    target_id=key, target_name=key,
                    detail={"value": "***" if is_secret else body.value},
                    request=request)
    display_value = ("••••••••" + body.value[-4:]) if is_secret and body.value else body.value
    return SettingItem(
        key=key,
        value=display_value,
        description=DEFAULTS[key]["description"],
        placeholder=DEFAULTS[key].get("placeholder"),
        secret=is_secret,
    )

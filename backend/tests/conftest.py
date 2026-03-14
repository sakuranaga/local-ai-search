"""Shared test fixtures for building mock users, roles, documents, and folders."""

import uuid
from datetime import datetime, timezone
from unittest.mock import MagicMock

import pytest

from app.models import Document, Folder, Group, Role, User, UserRole


# ---------------------------------------------------------------------------
# Helper factories
# ---------------------------------------------------------------------------


def make_role(name: str = "user", permissions: str = "") -> Role:
    role = MagicMock(spec=Role)
    role.id = 1
    role.name = name
    role.permissions = permissions
    return role


def make_user_role(role: Role) -> UserRole:
    ur = MagicMock(spec=UserRole)
    ur.role = role
    return ur


def make_user(
    user_id: uuid.UUID | None = None,
    username: str = "testuser",
    roles: list[str] | None = None,
) -> User:
    """Create a mock User with the given roles.

    roles is a list of permission strings, e.g. ["admin"] or ["user"].
    """
    uid = user_id or uuid.uuid4()
    user = MagicMock(spec=User)
    user.id = uid
    user.username = username
    user.email = f"{username}@test.local"
    user.is_active = True

    if roles is None:
        roles = ["user"]

    user_roles = []
    for i, perm in enumerate(roles):
        role = make_role(name=perm, permissions=perm)
        role.id = i + 1
        ur = make_user_role(role)
        ur.user_id = uid
        ur.role_id = role.id
        user_roles.append(ur)

    user.roles = user_roles
    return user


def make_document(
    owner_id: uuid.UUID | None = None,
    group_id: uuid.UUID | None = None,
    group_read: bool = False,
    group_write: bool = False,
    others_read: bool = True,
    others_write: bool = False,
) -> Document:
    doc = MagicMock(spec=Document)
    doc.id = uuid.uuid4()
    doc.title = "Test Document"
    doc.owner_id = owner_id
    doc.group_id = group_id
    doc.group_read = group_read
    doc.group_write = group_write
    doc.others_read = others_read
    doc.others_write = others_write
    return doc


def make_folder(
    owner_id: uuid.UUID | None = None,
    group_id: uuid.UUID | None = None,
    group_read: bool = False,
    group_write: bool = False,
    others_read: bool = True,
    others_write: bool = False,
) -> Folder:
    folder = MagicMock(spec=Folder)
    folder.id = uuid.uuid4()
    folder.name = "Test Folder"
    folder.owner_id = owner_id
    folder.group_id = group_id
    folder.group_read = group_read
    folder.group_write = group_write
    folder.others_read = others_read
    folder.others_write = others_write
    return folder

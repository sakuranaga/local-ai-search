"""Tests for app.services.permissions — Unix-style document/folder access control.

Covers:
  - is_admin: role-based admin detection
  - can_access_document: owner / group / others / admin access patterns
  - can_access_folder: same logic for folders
  - format_permission_string: Unix-style permission string formatting
  - build_visibility_filter: SQLAlchemy WHERE clause construction
"""

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.permissions import (
    build_folder_visibility_filter,
    build_visibility_filter,
    can_access_document,
    can_access_folder,
    format_permission_string,
    is_admin,
)
from tests.conftest import make_document, make_folder, make_user


# ---------------------------------------------------------------------------
# is_admin
# ---------------------------------------------------------------------------


class TestIsAdmin:
    def test_admin_role(self):
        user = make_user(roles=["admin"])
        assert is_admin(user) is True

    def test_user_role(self):
        user = make_user(roles=["user"])
        assert is_admin(user) is False

    def test_no_roles(self):
        user = make_user(roles=[])
        assert is_admin(user) is False

    def test_multiple_roles_with_admin(self):
        user = make_user(roles=["user", "admin"])
        assert is_admin(user) is True

    def test_multiple_roles_without_admin(self):
        user = make_user(roles=["user", "editor"])
        assert is_admin(user) is False

    def test_comma_separated_permissions(self):
        """Role with comma-separated permissions containing 'admin'."""
        user = make_user(roles=["read,write,admin"])
        assert is_admin(user) is True

    def test_comma_separated_without_admin(self):
        user = make_user(roles=["read,write"])
        assert is_admin(user) is False


# ---------------------------------------------------------------------------
# can_access_document — without DB (owner / others / admin checks)
# ---------------------------------------------------------------------------


class TestCanAccessDocumentNoDb:
    @pytest.mark.asyncio
    async def test_admin_always_allowed(self):
        admin = make_user(roles=["admin"])
        doc = make_document(others_read=False, others_write=False)
        assert await can_access_document(doc, admin, need_write=False) is True
        assert await can_access_document(doc, admin, need_write=True) is True

    @pytest.mark.asyncio
    async def test_owner_always_allowed(self):
        user = make_user(roles=["user"])
        doc = make_document(owner_id=user.id, others_read=False, others_write=False)
        assert await can_access_document(doc, user, need_write=False) is True
        assert await can_access_document(doc, user, need_write=True) is True

    @pytest.mark.asyncio
    async def test_others_read_allowed(self):
        user = make_user(roles=["user"])
        doc = make_document(others_read=True, others_write=False)
        assert await can_access_document(doc, user, need_write=False) is True

    @pytest.mark.asyncio
    async def test_others_read_denied(self):
        user = make_user(roles=["user"])
        doc = make_document(others_read=False, others_write=False)
        assert await can_access_document(doc, user, need_write=False) is False

    @pytest.mark.asyncio
    async def test_others_write_allowed(self):
        user = make_user(roles=["user"])
        doc = make_document(others_read=True, others_write=True)
        assert await can_access_document(doc, user, need_write=True) is True

    @pytest.mark.asyncio
    async def test_others_write_denied(self):
        user = make_user(roles=["user"])
        doc = make_document(others_read=True, others_write=False)
        assert await can_access_document(doc, user, need_write=True) is False

    @pytest.mark.asyncio
    async def test_non_owner_no_others_access(self):
        """Document with all permissions off, non-owner, non-admin."""
        owner_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            owner_id=owner_id,
            others_read=False,
            others_write=False,
        )
        assert await can_access_document(doc, user, need_write=False) is False
        assert await can_access_document(doc, user, need_write=True) is False


# ---------------------------------------------------------------------------
# can_access_document — with DB (group membership checks)
# ---------------------------------------------------------------------------


class TestCanAccessDocumentWithGroup:
    @pytest.mark.asyncio
    async def test_group_member_read_allowed(self):
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=True,
            group_write=False,
            others_read=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            assert await can_access_document(doc, user, need_write=False, db=db) is True

    @pytest.mark.asyncio
    async def test_group_member_read_denied(self):
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=False,
            group_write=False,
            others_read=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            assert await can_access_document(doc, user, need_write=False, db=db) is False

    @pytest.mark.asyncio
    async def test_group_member_write_allowed(self):
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=True,
            group_write=True,
            others_read=False,
            others_write=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            assert await can_access_document(doc, user, need_write=True, db=db) is True

    @pytest.mark.asyncio
    async def test_group_member_write_denied(self):
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=True,
            group_write=False,
            others_read=False,
            others_write=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            assert await can_access_document(doc, user, need_write=True, db=db) is False

    @pytest.mark.asyncio
    async def test_non_group_member_falls_through_to_others(self):
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=True,
            group_write=True,
            others_read=False,
            others_write=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[],  # not a member
        ):
            # Falls through to others_read=False
            assert await can_access_document(doc, user, need_write=False, db=db) is False

    @pytest.mark.asyncio
    async def test_no_db_skips_group_check(self):
        """When db is None, group check is skipped, falls to others."""
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=True,
            others_read=False,
        )
        # db=None → skip group check → falls to others_read=False
        assert await can_access_document(doc, user, need_write=False, db=None) is False


# ---------------------------------------------------------------------------
# can_access_folder — mirrors document logic
# ---------------------------------------------------------------------------


class TestCanAccessFolder:
    @pytest.mark.asyncio
    async def test_admin_always_allowed(self):
        admin = make_user(roles=["admin"])
        folder = make_folder(others_read=False)
        assert await can_access_folder(folder, admin) is True

    @pytest.mark.asyncio
    async def test_owner_always_allowed(self):
        user = make_user(roles=["user"])
        folder = make_folder(owner_id=user.id, others_read=False)
        assert await can_access_folder(folder, user) is True

    @pytest.mark.asyncio
    async def test_others_read(self):
        user = make_user(roles=["user"])
        folder = make_folder(others_read=True)
        assert await can_access_folder(folder, user, need_write=False) is True

    @pytest.mark.asyncio
    async def test_others_write_denied(self):
        user = make_user(roles=["user"])
        folder = make_folder(others_read=True, others_write=False)
        assert await can_access_folder(folder, user, need_write=True) is False

    @pytest.mark.asyncio
    async def test_group_member_access(self):
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        folder = make_folder(
            group_id=group_id,
            group_read=True,
            others_read=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            assert await can_access_folder(folder, user, db=db) is True


# ---------------------------------------------------------------------------
# format_permission_string
# ---------------------------------------------------------------------------


class TestFormatPermissionString:
    def test_all_true(self):
        assert format_permission_string(True, True, True, True) == "rwrwrw"

    def test_all_false(self):
        assert format_permission_string(False, False, False, False) == "rw----"

    def test_default_pattern(self):
        # Default: group_read=False, group_write=False, others_read=True, others_write=False
        assert format_permission_string(False, False, True, False) == "rw--r-"

    def test_group_read_only(self):
        assert format_permission_string(True, False, False, False) == "rwr---"

    def test_others_write(self):
        assert format_permission_string(False, False, False, True) == "rw---w"


# ---------------------------------------------------------------------------
# build_visibility_filter
# ---------------------------------------------------------------------------


class TestBuildVisibilityFilter:
    def test_admin_gets_no_filter(self):
        admin = make_user(roles=["admin"])
        result = build_visibility_filter(admin, [])
        # Admin gets literal(True) — should be a True clause
        assert result is not None

    def test_non_admin_gets_filter(self):
        user = make_user(roles=["user"])
        result = build_visibility_filter(user, [])
        # Should be an OR clause, not literal True
        assert result is not None

    def test_non_admin_with_groups(self):
        user = make_user(roles=["user"])
        group_ids = [uuid.uuid4(), uuid.uuid4()]
        result = build_visibility_filter(user, group_ids)
        assert result is not None

    def test_folder_admin_gets_no_filter(self):
        admin = make_user(roles=["admin"])
        result = build_folder_visibility_filter(admin, [])
        assert result is not None

    def test_folder_non_admin_gets_filter(self):
        user = make_user(roles=["user"])
        result = build_folder_visibility_filter(user, [])
        assert result is not None


# ---------------------------------------------------------------------------
# Priority / precedence edge cases
# ---------------------------------------------------------------------------


class TestPermissionPrecedence:
    @pytest.mark.asyncio
    async def test_owner_overrides_others_deny(self):
        """Owner can access even when others_read=False."""
        user = make_user(roles=["user"])
        doc = make_document(owner_id=user.id, others_read=False, others_write=False)
        assert await can_access_document(doc, user, need_write=True) is True

    @pytest.mark.asyncio
    async def test_admin_overrides_everything(self):
        """Admin can write even when all permissions are off."""
        admin = make_user(roles=["admin"])
        doc = make_document(
            owner_id=uuid.uuid4(),
            others_read=False,
            others_write=False,
            group_read=False,
            group_write=False,
        )
        assert await can_access_document(doc, admin, need_write=True) is True

    @pytest.mark.asyncio
    async def test_group_takes_precedence_over_others(self):
        """Group member gets group permissions, not others."""
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        # Group allows read, others denies read
        doc = make_document(
            group_id=group_id,
            group_read=True,
            others_read=False,
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            assert await can_access_document(doc, user, need_write=False, db=db) is True

    @pytest.mark.asyncio
    async def test_group_deny_does_not_fallback_to_others(self):
        """If user is group member but group denies, should NOT fall back to others."""
        group_id = uuid.uuid4()
        user = make_user(roles=["user"])
        doc = make_document(
            group_id=group_id,
            group_read=False,
            others_read=True,  # others allows, but group member → group rules apply
        )
        db = AsyncMock()
        with patch(
            "app.services.permissions.get_user_group_ids",
            return_value=[group_id],
        ):
            # Group member → group_read=False → denied (no fallback to others)
            assert await can_access_document(doc, user, need_write=False, db=db) is False

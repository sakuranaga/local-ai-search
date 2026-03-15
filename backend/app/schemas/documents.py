from datetime import datetime

from pydantic import BaseModel


class TagInfo(BaseModel):
    id: int
    name: str
    color: str | None


class DocumentListItem(BaseModel):
    id: str
    title: str
    summary: str | None = None
    source_path: str | None
    file_type: str
    owner_id: str | None = None
    owner_name: str | None = None
    group_id: str | None = None
    group_name: str | None = None
    group_read: bool = False
    group_write: bool = False
    others_read: bool = True
    others_write: bool = False
    permissions: str = "rw--r-"  # Unix-style string
    searchable: bool
    ai_knowledge: bool
    chunk_count: int
    memo: str | None
    folder_id: str | None = None
    folder_name: str | None = None
    tags: list[TagInfo] = []
    created_by_name: str | None
    updated_by_name: str | None
    scan_status: str = "pending"
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DocumentListResponse(BaseModel):
    items: list[DocumentListItem]
    total: int
    page: int
    per_page: int


class DocumentDetail(DocumentListItem):
    content: str
    files: list[dict]
    chunks: list[dict]


class DocumentUpdateRequest(BaseModel):
    title: str | None = None
    summary: str | None = None
    memo: str | None = None
    content: str | None = None  # Raw text content (triggers re-chunking)
    group_id: str | None = None  # UUID string or "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None
    searchable: bool | None = None
    ai_knowledge: bool | None = None
    folder_id: str | None = None  # UUID string or "" to unset
    tag_ids: list[int] | None = None  # replace all tags


class BulkDeleteRequest(BaseModel):
    ids: list[str]


class BulkActionRequest(BaseModel):
    ids: list[str]
    action: str  # "delete" | "reindex" | "set_permissions" | "move_to_folder" | "add_tags" | "remove_tags" | "set_searchable" | "set_ai_knowledge"
    # For set_permissions action (Unix-style)
    group_id: str | None = None  # UUID string or "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None
    # For move_to_folder action
    folder_id: str | None = None  # "" to unset
    # For add_tags / remove_tags actions
    tag_ids: list[int] | None = None
    # For set_searchable / set_ai_knowledge actions
    searchable: bool | None = None
    ai_knowledge: bool | None = None


class UnixPermissionsRequest(BaseModel):
    group_id: str | None = None  # UUID string or "" to unset
    group_read: bool | None = None
    group_write: bool | None = None
    others_read: bool | None = None
    others_write: bool | None = None


class TrashItem(BaseModel):
    id: str
    title: str
    file_type: str
    deleted_at: datetime


class TrashActionRequest(BaseModel):
    ids: list[str]

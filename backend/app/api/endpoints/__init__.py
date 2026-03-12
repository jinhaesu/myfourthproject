"""
Smart Finance Core - API Endpoints
"""
from app.api.endpoints import auth
from app.api.endpoints import users
from app.api.endpoints import vouchers
from app.api.endpoints import approvals
from app.api.endpoints import treasury
from app.api.endpoints import budget
from app.api.endpoints import ai
from app.api.endpoints import forecast
from app.api.endpoints import reports
from app.api.endpoints import admin
from app.api.endpoints import data_import
from app.api.endpoints import sales

__all__ = [
    "auth",
    "users",
    "vouchers",
    "approvals",
    "treasury",
    "budget",
    "ai",
    "forecast",
    "reports",
    "admin",
    "data_import",
    "sales"
]

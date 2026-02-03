"""
Smart Finance Core - Pydantic Schemas
API 요청/응답 스키마 정의
"""
from app.schemas.user import (
    UserCreate,
    UserUpdate,
    UserResponse,
    UserLogin,
    Token,
    TokenPayload,
    DepartmentCreate,
    DepartmentResponse,
    RoleResponse
)
from app.schemas.accounting import (
    AccountResponse,
    VoucherCreate,
    VoucherUpdate,
    VoucherResponse,
    VoucherLineCreate,
    VoucherLineResponse,
    VoucherListResponse
)
from app.schemas.approval import (
    ApprovalRequestCreate,
    ApprovalRequestResponse,
    ApprovalAction,
    ApprovalStepResponse,
    ApprovalLineCreate,
    ApprovalLineResponse
)
from app.schemas.treasury import (
    BankAccountCreate,
    BankAccountResponse,
    BankTransactionResponse,
    ReceivableCreate,
    ReceivableResponse,
    PayableCreate,
    PayableResponse,
    PaymentScheduleCreate,
    ReconciliationMatchResponse
)
from app.schemas.budget import (
    BudgetCreate,
    BudgetResponse,
    BudgetLineCreate,
    BudgetCheckResponse
)
from app.schemas.ai import (
    AIClassificationRequest,
    AIClassificationResponse,
    AIFeedbackRequest,
    CustomTagCreate,
    CustomTagResponse
)
from app.schemas.forecast import (
    PLForecastResponse,
    CashFlowForecastResponse,
    ScenarioSimulationRequest,
    ScenarioSimulationResponse
)

__all__ = [
    # User
    "UserCreate", "UserUpdate", "UserResponse", "UserLogin",
    "Token", "TokenPayload", "DepartmentCreate", "DepartmentResponse", "RoleResponse",
    # Accounting
    "AccountResponse", "VoucherCreate", "VoucherUpdate", "VoucherResponse",
    "VoucherLineCreate", "VoucherLineResponse", "VoucherListResponse",
    # Approval
    "ApprovalRequestCreate", "ApprovalRequestResponse", "ApprovalAction",
    "ApprovalStepResponse", "ApprovalLineCreate", "ApprovalLineResponse",
    # Treasury
    "BankAccountCreate", "BankAccountResponse", "BankTransactionResponse",
    "ReceivableCreate", "ReceivableResponse", "PayableCreate", "PayableResponse",
    "PaymentScheduleCreate", "ReconciliationMatchResponse",
    # Budget
    "BudgetCreate", "BudgetResponse", "BudgetLineCreate", "BudgetCheckResponse",
    # AI
    "AIClassificationRequest", "AIClassificationResponse", "AIFeedbackRequest",
    "CustomTagCreate", "CustomTagResponse",
    # Forecast
    "PLForecastResponse", "CashFlowForecastResponse",
    "ScenarioSimulationRequest", "ScenarioSimulationResponse"
]

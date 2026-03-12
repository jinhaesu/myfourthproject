"""
Smart Finance Core - Database Models
모든 데이터베이스 모델 정의
"""
from app.models.user import User, Role, Department, UserSession
from app.models.accounting import (
    Account,
    AccountCategory,
    Voucher,
    VoucherLine,
    VoucherAttachment,
    TransactionType
)
from app.models.approval import (
    ApprovalRequest,
    ApprovalStep,
    ApprovalLine,
    ApprovalHistory
)
from app.models.treasury import (
    BankAccount,
    BankTransaction,
    Receivable,
    Payable,
    PaymentSchedule,
    ReconciliationMatch
)
from app.models.budget import Budget, BudgetLine, BudgetUsage
from app.models.ai import (
    AIClassificationLog,
    AITrainingData,
    AIModelVersion,
    CustomTag,
    AIDataUploadHistory,
    AIRawTransactionData,
)
from app.models.audit import AuditLog, DataSnapshot
from app.models.sales import (
    SalesChannel,
    SalesRecord,
    SalesAutomationSchedule,
)

__all__ = [
    # User
    "User",
    "Role",
    "Department",
    "UserSession",
    # Accounting
    "Account",
    "AccountCategory",
    "Voucher",
    "VoucherLine",
    "VoucherAttachment",
    "TransactionType",
    # Approval
    "ApprovalRequest",
    "ApprovalStep",
    "ApprovalLine",
    "ApprovalHistory",
    # Treasury
    "BankAccount",
    "BankTransaction",
    "Receivable",
    "Payable",
    "PaymentSchedule",
    "ReconciliationMatch",
    # Budget
    "Budget",
    "BudgetLine",
    "BudgetUsage",
    # AI
    "AIClassificationLog",
    "AITrainingData",
    "AIModelVersion",
    "CustomTag",
    "AIDataUploadHistory",
    "AIRawTransactionData",
    # Audit
    "AuditLog",
    "DataSnapshot",
    # Sales
    "SalesChannel",
    "SalesRecord",
    "SalesAutomationSchedule",
]

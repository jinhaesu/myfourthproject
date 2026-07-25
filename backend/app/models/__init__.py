"""
Smart Finance Core - Database Models
모든 데이터베이스 모델 정의
"""
from app.models.user import User, Role, Department, UserSession
from app.models.accounting import (
    Account,
    AccountCategory,
    AccountCodeMapping,
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
from app.models.payroll import PayrollBatch, PayrollRecord
from app.models.card_alias import CardAlias
from app.models.card_classification import CardUsageClassification, CardMonthlyClosing
from app.models.purchase import (
    CatalogItem,
    CatalogPriceHistory,
    PurchaseRequest,
    PurchaseRequestItem,
    PurchaseRequestStatus,
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
    "AccountCodeMapping",
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
    # Payroll
    "PayrollBatch",
    "PayrollRecord",
    # Card
    "CardAlias",
    "CardUsageClassification",
    "CardMonthlyClosing",
    # Purchase
    "CatalogItem",
    "CatalogPriceHistory",
    "PurchaseRequest",
    "PurchaseRequestItem",
    "PurchaseRequestStatus",
]

from fastapi import FastAPI, APIRouter, HTTPException
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
from datetime import datetime
from bson import ObjectId

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app
app = FastAPI()
api_router = APIRouter(prefix="/api")

# ============= Models =============

class ReconciliationReason(BaseModel):
    type: str  # 'missing' or 'extra'
    reason: str  # NC, DBC, TV, Empty baki, Empty Return
    consumer_name: Optional[str] = None

class DeliveryCreate(BaseModel):
    date: str  # YYYY-MM-DD format
    employee_name: str
    cylinders_delivered: int
    empty_received: int
    online_payments: int
    paytm_payments: int
    partial_digital_amount: float
    cash_collected: float
    calculated_cash_cylinders: int
    calculated_cash_amount: float
    calculated_total_payable: float
    reconciliation_status: str = "pending"
    reconciliation_reasons: List[ReconciliationReason] = []

class Delivery(DeliveryCreate):
    id: str
    created_at: datetime

class EmployeeCreate(BaseModel):
    name: str

class Employee(BaseModel):
    id: str
    name: str
    active: bool = True
    created_at: datetime

class SettingsUpdate(BaseModel):
    cylinder_price: float

class Settings(BaseModel):
    cylinder_price: float
    price_history: List[dict] = []
    updated_at: datetime

# ============= Settings Endpoints =============

@api_router.get("/settings")
async def get_settings():
    settings = await db.settings.find_one()
    if not settings:
        # Create default settings
        default_settings = {
            "cylinder_price": 877.5,
            "price_history": [{"date": datetime.utcnow().isoformat(), "price": 877.5}],
            "updated_at": datetime.utcnow()
        }
        await db.settings.insert_one(default_settings)
        settings = default_settings
    
    settings['id'] = str(settings['_id'])
    del settings['_id']
    return settings

@api_router.put("/settings")
async def update_settings(settings_update: SettingsUpdate):
    current_settings = await db.settings.find_one()
    
    price_history = current_settings.get('price_history', []) if current_settings else []
    price_history.append({
        "date": datetime.utcnow().isoformat(),
        "price": settings_update.cylinder_price
    })
    
    update_data = {
        "cylinder_price": settings_update.cylinder_price,
        "price_history": price_history,
        "updated_at": datetime.utcnow()
    }
    
    if current_settings:
        await db.settings.update_one({"_id": current_settings["_id"]}, {"$set": update_data})
    else:
        await db.settings.insert_one(update_data)
    
    return {"message": "Settings updated successfully", "cylinder_price": settings_update.cylinder_price}

# ============= Employee Endpoints =============

@api_router.post("/employees", response_model=Employee)
async def create_employee(employee: EmployeeCreate):
    employee_dict = {
        "name": employee.name,
        "active": True,
        "created_at": datetime.utcnow()
    }
    result = await db.employees.insert_one(employee_dict)
    employee_dict['id'] = str(result.inserted_id)
    del employee_dict['_id']
    return employee_dict

@api_router.get("/employees", response_model=List[Employee])
async def get_employees():
    employees = await db.employees.find({"active": True}).to_list(1000)
    for emp in employees:
        emp['id'] = str(emp['_id'])
        del emp['_id']
    return employees

@api_router.delete("/employees/{employee_id}")
async def delete_employee(employee_id: str):
    result = await db.employees.update_one(
        {"_id": ObjectId(employee_id)},
        {"$set": {"active": False}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Employee not found")
    return {"message": "Employee deleted successfully"}

# ============= Delivery Endpoints =============

@api_router.post("/deliveries", response_model=Delivery)
async def create_delivery(delivery: DeliveryCreate):
    delivery_dict = delivery.dict()
    delivery_dict['created_at'] = datetime.utcnow()
    result = await db.deliveries.insert_one(delivery_dict)
    delivery_dict['id'] = str(result.inserted_id)
    del delivery_dict['_id']
    return delivery_dict

@api_router.get("/deliveries/date/{date}", response_model=List[Delivery])
async def get_deliveries_by_date(date: str):
    deliveries = await db.deliveries.find({"date": date}).to_list(1000)
    for delivery in deliveries:
        delivery['id'] = str(delivery['_id'])
        del delivery['_id']
    return deliveries

@api_router.put("/deliveries/{delivery_id}")
async def update_delivery(delivery_id: str, delivery: DeliveryCreate):
    result = await db.deliveries.update_one(
        {"_id": ObjectId(delivery_id)},
        {"$set": delivery.dict()}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Delivery not found")
    return {"message": "Delivery updated successfully"}

@api_router.get("/deliveries/summary/{date}")
async def get_daily_summary(date: str):
    deliveries = await db.deliveries.find({"date": date}).to_list(1000)
    
    if not deliveries:
        return {
            "total_cylinders_delivered": 0,
            "total_empty_received": 0,
            "total_online_payments": 0,
            "total_paytm_payments": 0,
            "total_partial_digital": 0,
            "total_cash_collected": 0
        }
    
    summary = {
        "total_cylinders_delivered": sum(d['cylinders_delivered'] for d in deliveries),
        "total_empty_received": sum(d['empty_received'] for d in deliveries),
        "total_online_payments": sum(d['online_payments'] for d in deliveries),
        "total_paytm_payments": sum(d['paytm_payments'] for d in deliveries),
        "total_partial_digital": sum(d['partial_digital_amount'] for d in deliveries),
        "total_cash_collected": sum(d['cash_collected'] for d in deliveries)
    }
    
    return summary

# ============= Include Router =============

app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()

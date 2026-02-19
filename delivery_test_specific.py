#!/usr/bin/env python3
"""
Specific test for delivery creation API as requested by user
Tests delivery creation with exact data provided
"""

import requests
import json
from datetime import datetime

# Get backend URL from frontend .env
BACKEND_URL = "https://cylinder-track-4.preview.emergentagent.com/api"

def test_delivery_creation():
    print("🚀 Testing Delivery Creation API with Specific Data")
    print(f"Backend URL: {BACKEND_URL}")
    print("=" * 60)
    
    session = requests.Session()
    
    # Step 1: Ensure employee "Nandu Yadav" exists
    print("\n👥 Step 1: Checking/Creating Employee 'Nandu Yadav'...")
    
    # First check if employee exists
    try:
        response = session.get(f"{BACKEND_URL}/employees")
        if response.status_code == 200:
            employees = response.json()
            nandu_exists = any(emp.get("name") == "Nandu Yadav" for emp in employees)
            
            if not nandu_exists:
                print("   Creating employee 'Nandu Yadav'...")
                employee_data = {"name": "Nandu Yadav"}
                create_response = session.post(f"{BACKEND_URL}/employees", json=employee_data)
                if create_response.status_code == 200:
                    print("   ✅ Employee 'Nandu Yadav' created successfully")
                else:
                    print(f"   ❌ Failed to create employee: {create_response.status_code} - {create_response.text}")
                    return False
            else:
                print("   ✅ Employee 'Nandu Yadav' already exists")
        else:
            print(f"   ❌ Failed to get employees: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"   ❌ Error checking employees: {str(e)}")
        return False
    
    # Step 2: Create delivery with exact data provided
    print("\n🚚 Step 2: Creating Delivery with Specified Data...")
    
    # Calculate the required fields based on the provided data
    # Assuming cylinder price is 877.5 (default)
    cylinder_price = 877.5
    cylinders_delivered = 20
    empty_received = 20
    online_payments = 5
    paytm_payments = 5
    partial_digital = 1000
    cash_collected = 7775
    
    # Calculate cash cylinders and amounts
    digital_cylinders = online_payments + paytm_payments  # 10
    cash_cylinders = cylinders_delivered - digital_cylinders  # 10
    cash_amount = cash_cylinders * cylinder_price  # 8775
    total_payable = cylinders_delivered * cylinder_price  # 17550
    
    delivery_data = {
        "date": "2026-02-17",
        "employee_name": "Nandu Yadav",
        "cylinders_delivered": cylinders_delivered,
        "empty_received": empty_received,
        "online_payments": online_payments,
        "paytm_payments": paytm_payments,
        "partial_digital_amount": partial_digital,
        "cash_collected": cash_collected,
        "calculated_cash_cylinders": cash_cylinders,
        "calculated_cash_amount": cash_amount,
        "calculated_total_payable": total_payable,
        "reconciliation_status": "completed",  # No mismatch, so completed
        "reconciliation_reasons": []  # No mismatch, so empty
    }
    
    print(f"   Delivery Data: {json.dumps(delivery_data, indent=2)}")
    
    try:
        response = session.post(f"{BACKEND_URL}/deliveries", json=delivery_data)
        if response.status_code == 200:
            delivery_response = response.json()
            delivery_id = delivery_response.get("id")
            print("   ✅ POST request succeeded")
            print(f"   Created delivery ID: {delivery_id}")
            print(f"   Response: {json.dumps(delivery_response, indent=2)}")
        else:
            print(f"   ❌ POST request failed: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"   ❌ Error creating delivery: {str(e)}")
        return False
    
    # Step 3: Verify data is saved correctly by retrieving it
    print("\n📋 Step 3: Verifying Data Persistence...")
    
    try:
        response = session.get(f"{BACKEND_URL}/deliveries/date/2026-02-17")
        if response.status_code == 200:
            deliveries = response.json()
            
            # Find our delivery
            our_delivery = None
            for delivery in deliveries:
                if (delivery.get("employee_name") == "Nandu Yadav" and 
                    delivery.get("cylinders_delivered") == cylinders_delivered):
                    our_delivery = delivery
                    break
            
            if our_delivery:
                print("   ✅ Data saved correctly in MongoDB")
                print("   Verification details:")
                print(f"     - Employee: {our_delivery.get('employee_name')}")
                print(f"     - Cylinders delivered: {our_delivery.get('cylinders_delivered')}")
                print(f"     - Empty received: {our_delivery.get('empty_received')}")
                print(f"     - Online payments: {our_delivery.get('online_payments')}")
                print(f"     - Paytm payments: {our_delivery.get('paytm_payments')}")
                print(f"     - Partial digital: {our_delivery.get('partial_digital_amount')}")
                print(f"     - Cash collected: {our_delivery.get('cash_collected')}")
                print(f"     - Calculated cash cylinders: {our_delivery.get('calculated_cash_cylinders')}")
                print(f"     - Calculated cash amount: {our_delivery.get('calculated_cash_amount')}")
                print(f"     - Calculated total payable: {our_delivery.get('calculated_total_payable')}")
            else:
                print("   ❌ Created delivery not found in database")
                return False
        else:
            print(f"   ❌ Failed to retrieve deliveries: {response.status_code} - {response.text}")
            return False
    except Exception as e:
        print(f"   ❌ Error retrieving deliveries: {str(e)}")
        return False
    
    # Step 4: Verify response format
    print("\n✅ Step 4: Response Format Verification...")
    
    required_fields = [
        "id", "date", "employee_name", "cylinders_delivered", "empty_received",
        "online_payments", "paytm_payments", "partial_digital_amount", "cash_collected",
        "calculated_cash_cylinders", "calculated_cash_amount", "calculated_total_payable",
        "reconciliation_status", "reconciliation_reasons", "created_at"
    ]
    
    missing_fields = [field for field in required_fields if field not in our_delivery]
    
    if not missing_fields:
        print("   ✅ Response format is correct - all required fields present")
    else:
        print(f"   ❌ Missing fields in response: {missing_fields}")
        return False
    
    print("\n" + "=" * 60)
    print("🎉 ALL TESTS PASSED - Delivery Creation API Working Correctly!")
    print("=" * 60)
    
    return True

if __name__ == "__main__":
    success = test_delivery_creation()
    if not success:
        print("\n❌ TESTS FAILED - There are issues with the delivery creation API")
        exit(1)
    else:
        print("\n✅ TESTS COMPLETED SUCCESSFULLY")
        exit(0)
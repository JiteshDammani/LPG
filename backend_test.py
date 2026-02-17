#!/usr/bin/env python3
"""
LPG Cylinder Delivery Management Backend API Tests
Tests all backend endpoints with realistic data
"""

import requests
import json
from datetime import datetime, date
import sys
import os

# Get backend URL from frontend .env
BACKEND_URL = "https://cylinder-track-4.preview.emergentagent.com/api"

class BackendTester:
    def __init__(self):
        self.base_url = BACKEND_URL
        self.session = requests.Session()
        self.test_results = {
            "settings": {"passed": 0, "failed": 0, "errors": []},
            "employees": {"passed": 0, "failed": 0, "errors": []},
            "deliveries": {"passed": 0, "failed": 0, "errors": []},
            "summary": {"passed": 0, "failed": 0, "errors": []}
        }
        self.created_employee_id = None
        self.created_delivery_id = None
        
    def log_result(self, category, test_name, success, error_msg=None):
        if success:
            self.test_results[category]["passed"] += 1
            print(f"✅ {test_name}")
        else:
            self.test_results[category]["failed"] += 1
            self.test_results[category]["errors"].append(f"{test_name}: {error_msg}")
            print(f"❌ {test_name}: {error_msg}")
    
    def test_settings_api(self):
        print("\n🔧 Testing Settings API...")
        
        # Test GET /api/settings
        try:
            response = self.session.get(f"{self.base_url}/settings")
            if response.status_code == 200:
                data = response.json()
                if "cylinder_price" in data and data["cylinder_price"] == 877.5:
                    self.log_result("settings", "GET /api/settings - Default price", True)
                else:
                    self.log_result("settings", "GET /api/settings - Default price", False, f"Expected price 877.5, got {data.get('cylinder_price')}")
            else:
                self.log_result("settings", "GET /api/settings", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("settings", "GET /api/settings", False, str(e))
        
        # Test PUT /api/settings
        try:
            new_price = 899.0
            update_data = {"cylinder_price": new_price}
            response = self.session.put(f"{self.base_url}/settings", json=update_data)
            if response.status_code == 200:
                # Verify the update
                get_response = self.session.get(f"{self.base_url}/settings")
                if get_response.status_code == 200:
                    data = get_response.json()
                    if data.get("cylinder_price") == new_price and "price_history" in data:
                        self.log_result("settings", "PUT /api/settings - Update price", True)
                    else:
                        self.log_result("settings", "PUT /api/settings - Update price", False, f"Price not updated correctly or history missing")
                else:
                    self.log_result("settings", "PUT /api/settings - Verification", False, f"Could not verify update")
            else:
                self.log_result("settings", "PUT /api/settings", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("settings", "PUT /api/settings", False, str(e))
    
    def test_employee_management_api(self):
        print("\n👥 Testing Employee Management API...")
        
        # Test POST /api/employees
        try:
            employee_data = {"name": "Rajesh Kumar"}
            response = self.session.post(f"{self.base_url}/employees", json=employee_data)
            if response.status_code == 200:
                data = response.json()
                if "id" in data and data["name"] == "Rajesh Kumar" and data["active"] == True:
                    self.created_employee_id = data["id"]
                    self.log_result("employees", "POST /api/employees - Create employee", True)
                else:
                    self.log_result("employees", "POST /api/employees - Create employee", False, "Invalid response structure")
            else:
                self.log_result("employees", "POST /api/employees", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("employees", "POST /api/employees", False, str(e))
        
        # Test GET /api/employees
        try:
            response = self.session.get(f"{self.base_url}/employees")
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list):
                    # Check if our created employee is in the list
                    found_employee = any(emp.get("name") == "Rajesh Kumar" and emp.get("active") == True for emp in data)
                    if found_employee:
                        self.log_result("employees", "GET /api/employees - List active employees", True)
                    else:
                        self.log_result("employees", "GET /api/employees - List active employees", False, "Created employee not found in list")
                else:
                    self.log_result("employees", "GET /api/employees", False, "Response is not a list")
            else:
                self.log_result("employees", "GET /api/employees", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("employees", "GET /api/employees", False, str(e))
        
        # Test DELETE /api/employees/{id} (soft delete)
        if self.created_employee_id:
            try:
                response = self.session.delete(f"{self.base_url}/employees/{self.created_employee_id}")
                if response.status_code == 200:
                    # Verify employee is no longer in active list
                    get_response = self.session.get(f"{self.base_url}/employees")
                    if get_response.status_code == 200:
                        data = get_response.json()
                        found_employee = any(emp.get("id") == self.created_employee_id for emp in data)
                        if not found_employee:
                            self.log_result("employees", "DELETE /api/employees/{id} - Soft delete", True)
                        else:
                            self.log_result("employees", "DELETE /api/employees/{id} - Soft delete", False, "Employee still appears in active list")
                    else:
                        self.log_result("employees", "DELETE /api/employees/{id} - Verification", False, "Could not verify deletion")
                else:
                    self.log_result("employees", "DELETE /api/employees/{id}", False, f"Status {response.status_code}: {response.text}")
            except Exception as e:
                self.log_result("employees", "DELETE /api/employees/{id}", False, str(e))
    
    def test_delivery_management_api(self):
        print("\n🚚 Testing Delivery Management API...")
        
        test_date = "2026-02-17"
        
        # Test POST /api/deliveries
        try:
            delivery_data = {
                "date": test_date,
                "employee_name": "Suresh Patel",
                "cylinders_delivered": 25,
                "empty_received": 23,
                "online_payments": 15,
                "paytm_payments": 5,
                "partial_digital_amount": 2500.0,
                "cash_collected": 4387.5,
                "calculated_cash_cylinders": 5,
                "calculated_cash_amount": 4387.5,
                "calculated_total_payable": 22437.5,
                "reconciliation_status": "completed",
                "reconciliation_reasons": [
                    {
                        "type": "missing",
                        "reason": "NC",
                        "consumer_name": "Sharma Ji"
                    },
                    {
                        "type": "extra",
                        "reason": "Empty Return",
                        "consumer_name": "Gupta Family"
                    }
                ]
            }
            response = self.session.post(f"{self.base_url}/deliveries", json=delivery_data)
            if response.status_code == 200:
                data = response.json()
                if "id" in data and data["employee_name"] == "Suresh Patel":
                    self.created_delivery_id = data["id"]
                    self.log_result("deliveries", "POST /api/deliveries - Create delivery with reconciliation", True)
                else:
                    self.log_result("deliveries", "POST /api/deliveries", False, "Invalid response structure")
            else:
                self.log_result("deliveries", "POST /api/deliveries", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("deliveries", "POST /api/deliveries", False, str(e))
        
        # Test GET /api/deliveries/date/{date}
        try:
            response = self.session.get(f"{self.base_url}/deliveries/date/{test_date}")
            if response.status_code == 200:
                data = response.json()
                if isinstance(data, list) and len(data) > 0:
                    # Check if our created delivery is in the list
                    found_delivery = any(d.get("employee_name") == "Suresh Patel" and d.get("date") == test_date for d in data)
                    if found_delivery:
                        self.log_result("deliveries", f"GET /api/deliveries/date/{test_date} - Get deliveries by date", True)
                    else:
                        self.log_result("deliveries", f"GET /api/deliveries/date/{test_date}", False, "Created delivery not found")
                else:
                    self.log_result("deliveries", f"GET /api/deliveries/date/{test_date}", False, "No deliveries returned or invalid format")
            else:
                self.log_result("deliveries", f"GET /api/deliveries/date/{test_date}", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("deliveries", f"GET /api/deliveries/date/{test_date}", False, str(e))
        
        # Test PUT /api/deliveries/{id}
        if self.created_delivery_id:
            try:
                update_data = {
                    "date": test_date,
                    "employee_name": "Suresh Patel",
                    "cylinders_delivered": 30,  # Updated value
                    "empty_received": 28,       # Updated value
                    "online_payments": 20,
                    "paytm_payments": 5,
                    "partial_digital_amount": 3000.0,
                    "cash_collected": 4387.5,
                    "calculated_cash_cylinders": 5,
                    "calculated_cash_amount": 4387.5,
                    "calculated_total_payable": 26925.0,  # Updated total
                    "reconciliation_status": "completed",
                    "reconciliation_reasons": []
                }
                response = self.session.put(f"{self.base_url}/deliveries/{self.created_delivery_id}", json=update_data)
                if response.status_code == 200:
                    self.log_result("deliveries", "PUT /api/deliveries/{id} - Update delivery", True)
                else:
                    self.log_result("deliveries", "PUT /api/deliveries/{id}", False, f"Status {response.status_code}: {response.text}")
            except Exception as e:
                self.log_result("deliveries", "PUT /api/deliveries/{id}", False, str(e))
    
    def test_daily_summary_api(self):
        print("\n📊 Testing Daily Summary API...")
        
        test_date = "2026-02-17"
        
        # Test GET /api/deliveries/summary/{date}
        try:
            response = self.session.get(f"{self.base_url}/deliveries/summary/{test_date}")
            if response.status_code == 200:
                data = response.json()
                required_fields = [
                    "total_cylinders_delivered",
                    "total_empty_received", 
                    "total_online_payments",
                    "total_paytm_payments",
                    "total_partial_digital",
                    "total_cash_collected"
                ]
                
                if all(field in data for field in required_fields):
                    # Check if totals are reasonable (should have our test delivery data)
                    if data["total_cylinders_delivered"] >= 30:  # From our updated delivery
                        self.log_result("summary", f"GET /api/deliveries/summary/{test_date} - Calculate daily totals", True)
                    else:
                        self.log_result("summary", f"GET /api/deliveries/summary/{test_date}", False, f"Totals seem incorrect: {data}")
                else:
                    missing_fields = [f for f in required_fields if f not in data]
                    self.log_result("summary", f"GET /api/deliveries/summary/{test_date}", False, f"Missing fields: {missing_fields}")
            else:
                self.log_result("summary", f"GET /api/deliveries/summary/{test_date}", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("summary", f"GET /api/deliveries/summary/{test_date}", False, str(e))
        
        # Test summary for empty date
        try:
            empty_date = "2026-01-01"
            response = self.session.get(f"{self.base_url}/deliveries/summary/{empty_date}")
            if response.status_code == 200:
                data = response.json()
                if all(data.get(field, -1) == 0 for field in ["total_cylinders_delivered", "total_empty_received"]):
                    self.log_result("summary", f"GET /api/deliveries/summary/{empty_date} - Empty date handling", True)
                else:
                    self.log_result("summary", f"GET /api/deliveries/summary/{empty_date}", False, "Should return zeros for empty date")
            else:
                self.log_result("summary", f"GET /api/deliveries/summary/{empty_date}", False, f"Status {response.status_code}: {response.text}")
        except Exception as e:
            self.log_result("summary", f"GET /api/deliveries/summary/{empty_date}", False, str(e))
    
    def run_all_tests(self):
        print(f"🚀 Starting Backend API Tests for LPG Cylinder Delivery Management")
        print(f"Backend URL: {self.base_url}")
        print("=" * 80)
        
        # Test in order of dependencies
        self.test_settings_api()
        self.test_employee_management_api()
        self.test_delivery_management_api()
        self.test_daily_summary_api()
        
        # Print summary
        print("\n" + "=" * 80)
        print("📋 TEST SUMMARY")
        print("=" * 80)
        
        total_passed = sum(cat["passed"] for cat in self.test_results.values())
        total_failed = sum(cat["failed"] for cat in self.test_results.values())
        
        for category, results in self.test_results.items():
            status = "✅ PASS" if results["failed"] == 0 else "❌ FAIL"
            print(f"{category.upper():12} | {status} | {results['passed']} passed, {results['failed']} failed")
            
            if results["errors"]:
                for error in results["errors"]:
                    print(f"             | ❌ {error}")
        
        print("-" * 80)
        print(f"OVERALL      | {'✅ PASS' if total_failed == 0 else '❌ FAIL'} | {total_passed} passed, {total_failed} failed")
        
        return total_failed == 0

if __name__ == "__main__":
    tester = BackendTester()
    success = tester.run_all_tests()
    sys.exit(0 if success else 1)
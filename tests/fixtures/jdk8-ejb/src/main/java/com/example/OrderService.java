package com.example;

import javax.ejb.Stateless;
import javax.ejb.TransactionAttribute;
import javax.ejb.TransactionAttributeType;

@Stateless
public class OrderService {

    @TransactionAttribute(TransactionAttributeType.REQUIRED)
    public String placeOrder(String productId, int qty) {
        return "ORD-" + System.currentTimeMillis();
    }

    public void cancelOrder(String orderId) {
        // cancel logic
    }
}

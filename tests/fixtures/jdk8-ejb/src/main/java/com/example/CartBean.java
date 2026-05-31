package com.example;

import javax.annotation.Resource;
import javax.ejb.Remove;
import javax.ejb.SessionContext;
import javax.ejb.Stateful;
import java.util.ArrayList;
import java.util.List;

@Stateful
public class CartBean {

    @Resource
    private SessionContext ctx;

    private List<String> items = new ArrayList<>();

    public void addItem(String item) {
        items.add(item);
    }

    public List<String> getItems() {
        return items;
    }

    @Remove
    public String checkout() {
        if (items.isEmpty()) {
            ctx.setRollbackOnly();
            return null;
        }
        return "ORDER-" + items.size();
    }
}

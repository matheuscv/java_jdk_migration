package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import javax.servlet.http.HttpServletRequest;

@RestController
public class HelloController {

    @GetMapping("/hello")
    public String hello(HttpServletRequest request) {
        // javax.servlet.http.HttpServletRequest → jakarta.servlet.http.HttpServletRequest
        return "Hello from " + request.getServerName();
    }
}

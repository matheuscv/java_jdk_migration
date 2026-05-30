package com.example;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import sun.misc.BASE64Encoder;
import javax.xml.bind.JAXBContext;
import javax.annotation.PostConstruct;

@RestController
public class LegacyController {

    @PostConstruct
    public void init() {
        System.out.println("Controller initialized");
    }

    @GetMapping("/encode")
    public String encode(@RequestParam String value) {
        // Uses removed sun.misc.BASE64Encoder — should use java.util.Base64
        BASE64Encoder encoder = new BASE64Encoder();
        return encoder.encode(value.getBytes());
    }

    @GetMapping("/jaxb")
    public String jaxbExample() throws Exception {
        // Uses removed javax.xml.bind — should use jakarta.xml.bind + external dep
        JAXBContext ctx = JAXBContext.newInstance(LegacyController.class);
        return ctx.toString();
    }
}

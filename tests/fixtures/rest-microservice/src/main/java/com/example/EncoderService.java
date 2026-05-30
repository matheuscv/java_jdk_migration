package com.example;

import org.springframework.stereotype.Service;
import sun.misc.BASE64Encoder;

@Service
public class EncoderService {

    // sun.misc.BASE64Encoder foi removido no JDK 9.
    // Deve ser substituído por java.util.Base64.getEncoder()
    public String encode(String value) {
        BASE64Encoder encoder = new BASE64Encoder();
        return encoder.encode(value.getBytes());
    }
}

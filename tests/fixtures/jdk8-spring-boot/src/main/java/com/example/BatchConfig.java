package com.example;

import org.springframework.batch.core.Job;
import org.springframework.batch.core.Step;
import org.springframework.batch.core.configuration.annotation.EnableBatchProcessing;
import org.springframework.batch.core.configuration.annotation.JobBuilderFactory;
import org.springframework.batch.core.configuration.annotation.StepBuilderFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.batch.repeat.RepeatStatus;

// JobBuilderFactory e StepBuilderFactory foram REMOVIDOS no Spring Batch 5.
// @EnableBatchProcessing conflita com o autoconfiguration do Spring Boot 3.
@Configuration
@EnableBatchProcessing
public class BatchConfig {

    @Autowired
    private JobBuilderFactory jobBuilderFactory;  // REMOVIDO no Batch 5

    @Autowired
    private StepBuilderFactory stepBuilderFactory;  // REMOVIDO no Batch 5

    @Bean
    public Job migrateDataJob() {
        return jobBuilderFactory.get("migrateDataJob")
            .start(migrateStep())
            .build();
    }

    @Bean
    public Step migrateStep() {
        return stepBuilderFactory.get("migrateStep")
            .tasklet((contribution, chunkContext) -> {
                System.out.println("Executing migration step");
                return RepeatStatus.FINISHED;
            })
            .build();
    }
}

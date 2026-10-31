package demo;

import java.util.List;

public class Account {
    private int balance;

    public Account(int initial) {
        this.balance = initial;
    }

    public void deposit(int amount) {
        balance += amount;
    }

    public void audit() {
        String café = "x"; Logger.log(café);
        this.deposit(1);
        List<Account> all = new ArrayList<>();
    }
}

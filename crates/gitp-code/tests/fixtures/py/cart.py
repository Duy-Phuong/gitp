from .money import money

RATE = 1


class Cart:
    def __init__(self):
        self.items = []

    def add(self, item):
        self.items.append(item)


def total(cart, x):
    cart.add(x)
    c = Cart()
    return money(len(c.items))

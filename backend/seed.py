from .config import DATA_ROOT, initialize
from .datasets import DatasetService
from .simulations import ScenarioService

if __name__ == '__main__':
    initialize()
    ScenarioService(DATA_ROOT, DatasetService(DATA_ROOT)).seed_demo()
    print(f'Demonstration fixtures ready in {DATA_ROOT}. NOT FOR OPERATIONAL FLOOD FORECASTING.')
